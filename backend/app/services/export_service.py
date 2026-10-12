import io
import re
from typing import List, Optional, Literal
from datetime import datetime

import docx
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_ALIGN_VERTICAL
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import qn, nsdecls

import pymupdf

from backend.app.models.exam import Exam, ExamGroup, ExamQuestion


def sanitize_export_filename(title: str, group_suffix: Optional[str], extension: str) -> str:
    """Sanitizes filename for Content-Disposition header, stripping unsafe characters."""
    base = f"{title}_{group_suffix}" if group_suffix else f"{title}_Compiled_Master"
    # Replace non-alphanumeric characters except dash, underscore, and dot
    clean = re.sub(r"[^a-zA-Z0-9_\-\.]", "_", base)
    clean = re.sub(r"_+", "_", clean).strip("._")
    if not clean:
        clean = "Examination_Paper"
    return f"{clean[:60]}.{extension.lstrip('.')}"


class ExamExportService:
    """Production-grade Export Engine for generating professional Academic Examination Papers

    and Teacher Answer Keys in DOCX and PDF formats.
    Supports 1 through 10 groups, arbitrary question type distributions,
    and LTR / RTL multilingual layouts.
    """

    # -------------------------------------------------------------------------
    # DOCX GENERATION
    # -------------------------------------------------------------------------
    def generate_docx(
        self,
        exam: Exam,
        groups: List[ExamGroup],
        target: Literal["both", "exam", "answer_key"] = "both",
        include_references: bool = True,
    ) -> io.BytesIO:
        """Constructs a production-ready DOCX document in-memory using python-docx."""
        doc = docx.Document()
        is_rtl = bool(exam.is_rtl)

        # Page Setup: Standard A4 / Letter with 0.75 in margins
        for section in doc.sections:
            section.top_margin = Inches(0.75)
            section.bottom_margin = Inches(0.75)
            section.left_margin = Inches(0.75)
            section.right_margin = Inches(0.75)
            section.page_width = Inches(8.5)
            section.page_height = Inches(11.0)

            # Footer: Confidential & page notice
            footer = section.footer
            footer_p = footer.paragraphs[0]
            footer_p.text = f"{exam.title} | ExamCraft AI Academic Assessment"
            footer_p.alignment = WD_ALIGN_PARAGRAPH.RIGHT if is_rtl else WD_ALIGN_PARAGRAPH.LEFT
            if footer_p.runs:
                footer_p.runs[0].font.size = Pt(8.5)
                footer_p.runs[0].font.color.rgb = RGBColor(120, 120, 120)

        # Iterate over groups to generate
        total_groups = len(groups)
        for g_idx, group in enumerate(groups):
            # Calculate group-specific marks
            group_marks = sum(q.marks for q in group.questions) if group.questions else exam.total_marks

            # 1. Render Student Examination Paper
            if target in ["both", "exam"]:
                self._render_docx_student_paper(
                    doc=doc,
                    exam=exam,
                    group=group,
                    group_marks=group_marks,
                    is_rtl=is_rtl,
                )

            # 2. Render Teacher Answer Key & References
            if target in ["both", "answer_key"]:
                if target == "both":
                    doc.add_page_break()

                self._render_docx_answer_key(
                    doc=doc,
                    exam=exam,
                    group=group,
                    include_references=include_references,
                    is_rtl=is_rtl,
                )

            # If there are more groups and this is a compiled export, add a page break between groups
            if g_idx < total_groups - 1:
                doc.add_page_break()

        buffer = io.BytesIO()
        doc.save(buffer)
        buffer.seek(0)
        return buffer

    def _render_docx_student_paper(
        self,
        doc: docx.Document,
        exam: Exam,
        group: ExamGroup,
        group_marks: float,
        is_rtl: bool,
    ):
        """Renders the official student-facing examination paper."""
        align_title = WD_ALIGN_PARAGRAPH.CENTER
        align_text = WD_ALIGN_PARAGRAPH.RIGHT if is_rtl else WD_ALIGN_PARAGRAPH.LEFT

        # Institution Header
        p_inst = doc.add_paragraph()
        p_inst.alignment = align_title
        r_inst = p_inst.add_run(exam.institution or "ACADEMIC INSTITUTION")
        r_inst.bold = True
        r_inst.font.size = Pt(13)
        r_inst.font.color.rgb = RGBColor(40, 40, 40)
        if is_rtl:
            self._set_p_rtl(p_inst)
            self._set_run_rtl(r_inst)

        # Exam Title
        p_title = doc.add_paragraph()
        p_title.alignment = align_title
        p_title.paragraph_format.space_before = Pt(2)
        p_title.paragraph_format.space_after = Pt(4)
        r_title = p_title.add_run(exam.title)
        r_title.bold = True
        r_title.font.size = Pt(16)
        r_title.font.color.rgb = RGBColor(15, 23, 42)
        if is_rtl:
            self._set_p_rtl(p_title)
            self._set_run_rtl(r_title)

        # Subject & Grade Level
        p_sub = doc.add_paragraph()
        p_sub.alignment = align_title
        p_sub.paragraph_format.space_after = Pt(10)
        sub_text = f"Subject: {exam.subject}"
        if exam.grade_level:
            sub_text += f"   |   Class / Grade: {exam.grade_level}"
        if exam.teacher_name:
            sub_text += f"   |   Instructor: {exam.teacher_name}"
        r_sub = p_sub.add_run(sub_text)
        r_sub.italic = True
        r_sub.font.size = Pt(10)
        r_sub.font.color.rgb = RGBColor(70, 70, 70)
        if is_rtl:
            self._set_p_rtl(p_sub)
            self._set_run_rtl(r_sub)

        # Student Details Box (Table: 2 rows x 4 columns)
        table = doc.add_table(rows=2, cols=4)
        table.alignment = WD_TABLE_ALIGNMENT.CENTER
        if is_rtl:
            self._set_tbl_rtl(table)

        row0 = table.rows[0].cells
        row0[0].text = "Student Name: _________________________"
        row0[1].text = ""
        row0[2].text = "Roll / Seat No: ____________"
        row0[3].text = ""

        row1 = table.rows[1].cells
        row1[0].text = f"Date: {exam.exam_date or datetime.utcnow().strftime('%Y-%m-%d')}"
        row1[1].text = f"Time: {exam.duration_minutes} Mins"
        row1[2].text = f"Max Marks: {group_marks} pts"
        row1[3].text = f"Group: {group.group_name}"

        # Style Table cells
        for row in table.rows:
            for cell in row.cells:
                cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
                for p in cell.paragraphs:
                    p.paragraph_format.space_before = Pt(3)
                    p.paragraph_format.space_after = Pt(3)
                    if is_rtl:
                        self._set_p_rtl(p)
                    for r in p.runs:
                        r.font.size = Pt(9.5)
                        r.font.color.rgb = RGBColor(30, 41, 59)
                        if is_rtl:
                            self._set_run_rtl(r)

        # Instructions Block
        doc.add_paragraph().paragraph_format.space_before = Pt(6)
        p_inst_box = doc.add_paragraph()
        p_inst_box.paragraph_format.space_after = Pt(12)
        if is_rtl:
            self._set_p_rtl(p_inst_box)
            p_inst_box.alignment = align_text
        r_inst_label = p_inst_box.add_run("GENERAL INSTRUCTIONS: ")
        r_inst_label.bold = True
        r_inst_label.font.size = Pt(9.5)
        r_inst_body = p_inst_box.add_run(
            "1. Check that this paper contains all questions for your designated examination group. "
            "2. Write all answers clearly in the spaces provided. "
            "3. Ensure your name and seat number are recorded above. "
            "4. Unauthorized devices, calculators, or reference materials are strictly prohibited."
        )
        r_inst_body.italic = True
        r_inst_body.font.size = Pt(9.0)
        r_inst_body.font.color.rgb = RGBColor(80, 80, 80)

        # Questions List (Sorted by question_order)
        sorted_questions = sorted(group.questions, key=lambda q: q.question_order)
        for idx, q in enumerate(sorted_questions, start=1):
            p_q = doc.add_paragraph()
            p_q.paragraph_format.space_before = Pt(8)
            p_q.paragraph_format.space_after = Pt(3)
            if is_rtl:
                self._set_p_rtl(p_q)
                p_q.alignment = align_text

            # Question Header: Number & Marks
            r_num = p_q.add_run(f"Q{idx}. ")
            r_num.bold = True
            r_num.font.size = Pt(10.5)

            r_text = p_q.add_run(q.question_text)
            r_text.font.size = Pt(10.5)

            # Marks indicator
            marks_str = f" [{q.marks:g} pt{'s' if q.marks != 1 else ''}]"
            r_marks = p_q.add_run(marks_str)
            r_marks.bold = True
            r_marks.font.size = Pt(9.5)
            r_marks.font.color.rgb = RGBColor(120, 50, 80)

            # Question Type presentation
            q_type = (q.question_type or "").lower()

            if q_type in ["mcq", "multiple_choice"] and q.options:
                option_labels = ["A", "B", "C", "D", "E", "F"]
                for o_idx, opt in enumerate(q.options):
                    p_opt = doc.add_paragraph()
                    p_opt.paragraph_format.left_indent = Inches(0.4)
                    p_opt.paragraph_format.space_before = Pt(1)
                    p_opt.paragraph_format.space_after = Pt(1)
                    if is_rtl:
                        self._set_p_rtl(p_opt)
                        p_opt.alignment = align_text

                    lbl = option_labels[o_idx] if o_idx < len(option_labels) else str(o_idx + 1)
                    # Strip pre-existing A: or (A) if already in text
                    cleaned_opt = re.sub(r"^[A-Fa-f0-9][\:\.\)]\s*", "", str(opt)).strip()
                    r_opt_lbl = p_opt.add_run(f"({lbl})  ")
                    r_opt_lbl.bold = True
                    r_opt_lbl.font.size = Pt(9.5)
                    r_opt_text = p_opt.add_run(cleaned_opt)
                    r_opt_text.font.size = Pt(9.5)

                # Blank Answer line for student choice
                p_ans_space = doc.add_paragraph()
                p_ans_space.paragraph_format.left_indent = Inches(0.4)
                p_ans_space.paragraph_format.space_before = Pt(2)
                p_ans_space.paragraph_format.space_after = Pt(6)
                if is_rtl:
                    self._set_p_rtl(p_ans_space)
                    p_ans_space.alignment = align_text
                r_ans_box = p_ans_space.add_run("Selected Option:  [ ______ ]")
                r_ans_box.italic = True
                r_ans_box.font.size = Pt(9.0)
                r_ans_box.font.color.rgb = RGBColor(100, 100, 100)

            elif q_type == "true_false":
                p_tf = doc.add_paragraph()
                p_tf.paragraph_format.left_indent = Inches(0.4)
                p_tf.paragraph_format.space_before = Pt(2)
                p_tf.paragraph_format.space_after = Pt(6)
                if is_rtl:
                    self._set_p_rtl(p_tf)
                    p_tf.alignment = align_text
                r_tf = p_tf.add_run("[   ]  True               [   ]  False")
                r_tf.font.size = Pt(10.0)

            elif q_type == "fill_blank":
                p_fb = doc.add_paragraph()
                p_fb.paragraph_format.left_indent = Inches(0.4)
                p_fb.paragraph_format.space_before = Pt(3)
                p_fb.paragraph_format.space_after = Pt(6)
                if is_rtl:
                    self._set_p_rtl(p_fb)
                    p_fb.alignment = align_text
                r_fb = p_fb.add_run("Answer: __________________________________________________________________")
                r_fb.font.size = Pt(9.5)

            elif q_type in ["short_answer", "essay"]:
                # Number of lines: 3 for short answer, 7 for essay
                lines_count = 7 if q_type == "essay" else 3
                for _ in range(lines_count):
                    p_line = doc.add_paragraph()
                    p_line.paragraph_format.left_indent = Inches(0.2)
                    p_line.paragraph_format.space_before = Pt(2)
                    p_line.paragraph_format.space_after = Pt(2)
                    if is_rtl:
                        self._set_p_rtl(p_line)
                        p_line.alignment = align_text
                    r_dot = p_line.add_run(
                        ". . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . ."
                    )
                    r_dot.font.size = Pt(8.5)
                    r_dot.font.color.rgb = RGBColor(170, 170, 170)
            else:
                # Default handwriting space for any other question type
                p_line = doc.add_paragraph()
                p_line.paragraph_format.left_indent = Inches(0.2)
                p_line.paragraph_format.space_before = Pt(3)
                p_line.paragraph_format.space_after = Pt(6)
                if is_rtl:
                    self._set_p_rtl(p_line)
                    p_line.alignment = align_text
                r_line = p_line.add_run("Response: _________________________________________________________________")
                r_line.font.size = Pt(9.5)

        # End of Exam notice
        p_end = doc.add_paragraph()
        p_end.paragraph_format.space_before = Pt(16)
        p_end.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r_end = p_end.add_run(f"--- END OF EXAMINATION PAPER ({group.group_name}) ---")
        r_end.bold = True
        r_end.font.size = Pt(9.5)
        r_end.font.color.rgb = RGBColor(120, 120, 120)

    def _render_docx_answer_key(
        self,
        doc: docx.Document,
        exam: Exam,
        group: ExamGroup,
        include_references: bool,
        is_rtl: bool,
    ):
        """Renders the Teacher Answer Key & Scoring Rubrics with provenance."""
        align_title = WD_ALIGN_PARAGRAPH.CENTER
        align_text = WD_ALIGN_PARAGRAPH.RIGHT if is_rtl else WD_ALIGN_PARAGRAPH.LEFT

        p_hdr = doc.add_paragraph()
        p_hdr.alignment = align_title
        r_hdr = p_hdr.add_run("CONFIDENTIAL - TEACHER ANSWER KEY & SCORING RUBRICS")
        r_hdr.bold = True
        r_hdr.font.size = Pt(13)
        r_hdr.font.color.rgb = RGBColor(153, 27, 27)  # Dark red/maroon
        if is_rtl:
            self._set_p_rtl(p_hdr)
            self._set_run_rtl(r_hdr)

        p_sub = doc.add_paragraph()
        p_sub.alignment = align_title
        p_sub.paragraph_format.space_after = Pt(10)
        r_sub = p_sub.add_run(f"{exam.title}   |   Variant: {group.group_name}")
        r_sub.italic = True
        r_sub.font.size = Pt(10)
        if is_rtl:
            self._set_p_rtl(p_sub)
            self._set_run_rtl(r_sub)

        sorted_questions = sorted(group.questions, key=lambda q: q.question_order)

        # Build Answer Key Table
        # Columns: Q#, Type, Marks, Correct Answer, Explanation
        # If include_references: add Source Reference & Evidence
        cols_count = 6 if include_references else 4
        table = doc.add_table(rows=1, cols=cols_count)
        table.alignment = WD_TABLE_ALIGNMENT.CENTER
        if is_rtl:
            self._set_tbl_rtl(table)

        # Style Header Row
        hdr_cells = table.rows[0].cells
        hdr_labels = ["Q#", "Type", "Marks", "Correct Answer"]
        if include_references:
            hdr_labels.extend(["Explanation", "Source Provenance"])
        else:
            hdr_labels.append("Explanation")

        for c_idx, label in enumerate(hdr_labels):
            cell = hdr_cells[c_idx]
            cell.text = label
            # Add subtle gray background to header
            shading = parse_xml(r'<w:shd {} w:fill="F1F5F9"/>'.format(nsdecls('w')))
            cell._tc.get_or_add_tcPr().append(shading)
            for p in cell.paragraphs:
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                if is_rtl:
                    self._set_p_rtl(p)
                for r in p.runs:
                    r.bold = True
                    r.font.size = Pt(9.0)
                    r.font.color.rgb = RGBColor(30, 41, 59)
                    if is_rtl:
                        self._set_run_rtl(r)

        # Populate rows
        for idx, q in enumerate(sorted_questions, start=1):
            row_cells = table.add_row().cells
            row_cells[0].text = f"Q{idx}"
            row_cells[1].text = q.question_type or "-"
            row_cells[2].text = f"{q.marks:g} pt"
            row_cells[3].text = q.correct_answer or "-"

            if include_references:
                row_cells[4].text = q.explanation or "-"
                # Provenance details
                prov_parts = []
                if q.source_document_name:
                    prov_parts.append(f"Doc: {q.source_document_name}")
                if q.source_page:
                    prov_parts.append(f"Page: {q.source_page}")
                if q.source_chapter:
                    prov_parts.append(f"Ch: {q.source_chapter}")
                if q.source_evidence:
                    prov_parts.append(f'Evidence: "{q.source_evidence}"')
                row_cells[5].text = "\n".join(prov_parts) if prov_parts else "-"
            else:
                row_cells[4].text = q.explanation or "-"

            # Format cell paragraphs
            for c_i, cell in enumerate(row_cells):
                for p in cell.paragraphs:
                    p.paragraph_format.space_before = Pt(2)
                    p.paragraph_format.space_after = Pt(2)
                    if c_i in [0, 1, 2]:
                        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                    else:
                        p.alignment = align_text
                    if is_rtl:
                        self._set_p_rtl(p)
                    for r in p.runs:
                        r.font.size = Pt(8.5)
                        if is_rtl:
                            self._set_run_rtl(r)

    # -------------------------------------------------------------------------
    # PDF GENERATION
    # -------------------------------------------------------------------------
    def generate_pdf(
        self,
        exam: Exam,
        groups: List[ExamGroup],
        target: Literal["both", "exam", "answer_key"] = "both",
        include_references: bool = True,
    ) -> io.BytesIO:
        """Constructs a production-ready PDF document in-memory using PyMuPDF."""
        pdf_doc = pymupdf.open()
        is_rtl = bool(exam.is_rtl)

        for g_idx, group in enumerate(groups):
            group_marks = sum(q.marks for q in group.questions) if group.questions else exam.total_marks

            # 1. Render Student Examination Paper
            if target in ["both", "exam"]:
                self._render_pdf_student_paper(
                    pdf_doc=pdf_doc,
                    exam=exam,
                    group=group,
                    group_marks=group_marks,
                    is_rtl=is_rtl,
                )

            # 2. Render Teacher Answer Key & References
            if target in ["both", "answer_key"]:
                self._render_pdf_answer_key(
                    pdf_doc=pdf_doc,
                    exam=exam,
                    group=group,
                    include_references=include_references,
                    is_rtl=is_rtl,
                )

        pdf_bytes = pdf_doc.tobytes()
        buffer = io.BytesIO(pdf_bytes)
        buffer.seek(0)
        return buffer

    def _render_pdf_student_paper(
        self,
        pdf_doc: pymupdf.Document,
        exam: Exam,
        group: ExamGroup,
        group_marks: float,
        is_rtl: bool,
    ):
        """Renders student exam paper to PDF pages with dynamic pagination."""
        page_width, page_height = 595.32, 841.92  # A4 Points
        margin_x = 45.0
        content_width = page_width - (2 * margin_x)
        max_y = page_height - 50.0

        page = pdf_doc.new_page(width=page_width, height=page_height)
        curr_y = 45.0

        # Header Block
        inst_text = exam.institution or "ACADEMIC INSTITUTION"
        inst_rect = pymupdf.Rect(margin_x, curr_y, page_width - margin_x, curr_y + 16.0)
        page.insert_textbox(
            inst_rect,
            inst_text,
            fontsize=12,
            fontname="helv",
            color=(0.15, 0.15, 0.15),
            align=pymupdf.TEXT_ALIGN_CENTER,
        )
        curr_y += 18.0

        title_rect = pymupdf.Rect(margin_x, curr_y, page_width - margin_x, curr_y + 20.0)
        page.insert_textbox(
            title_rect,
            exam.title,
            fontsize=15,
            fontname="helv",
            color=(0.05, 0.1, 0.2),
            align=pymupdf.TEXT_ALIGN_CENTER,
        )
        curr_y += 20.0

        sub_info = f"Subject: {exam.subject}"
        if exam.grade_level:
            sub_info += f"  |  Grade: {exam.grade_level}"
        if exam.teacher_name:
            sub_info += f"  |  Instructor: {exam.teacher_name}"

        sub_rect = pymupdf.Rect(margin_x, curr_y, page_width - margin_x, curr_y + 14.0)
        page.insert_textbox(
            sub_rect,
            sub_info,
            fontsize=9,
            fontname="helv",
            color=(0.3, 0.3, 0.3),
            align=pymupdf.TEXT_ALIGN_CENTER,
        )
        curr_y += 16.0

        # Horizontal Divider
        page.draw_line((margin_x, curr_y), (page_width - margin_x, curr_y), color=(0.8, 0.8, 0.8), width=0.8)
        curr_y += 10.0

        # Student Details Box
        box_rect = pymupdf.Rect(margin_x, curr_y, page_width - margin_x, curr_y + 36.0)
        page.draw_rect(box_rect, color=(0.75, 0.75, 0.75), width=0.7)
        page.insert_text(
            (margin_x + 8.0, curr_y + 14.0),
            "Student Name: ___________________________",
            fontsize=8.5,
            fontname="helv",
            color=(0.1, 0.1, 0.1),
        )
        page.insert_text(
            (margin_x + 320.0, curr_y + 14.0),
            "Roll / Seat No: ____________",
            fontsize=8.5,
            fontname="helv",
            color=(0.1, 0.1, 0.1),
        )
        date_str = exam.exam_date or datetime.utcnow().strftime("%Y-%m-%d")
        page.insert_text(
            (margin_x + 8.0, curr_y + 28.0),
            f"Date: {date_str}    |    Duration: {exam.duration_minutes} Mins",
            fontsize=8.5,
            fontname="helv",
            color=(0.2, 0.2, 0.2),
        )
        page.insert_text(
            (margin_x + 320.0, curr_y + 28.0),
            f"Max Marks: {group_marks:g} pts    |    Variant: {group.group_name}",
            fontsize=8.5,
            fontname="helv",
            color=(0.2, 0.2, 0.2),
        )
        curr_y += 44.0

        # Instructions
        inst_rect = pymupdf.Rect(margin_x, curr_y, page_width - margin_x, curr_y + 20.0)
        inst_text = "Instructions: Answer all questions in the space provided. Unauthorized materials are strictly prohibited."
        page.insert_textbox(
            inst_rect,
            inst_text,
            fontsize=8.0,
            fontname="helv",
            color=(0.4, 0.4, 0.4),
            align=pymupdf.TEXT_ALIGN_LEFT if not is_rtl else pymupdf.TEXT_ALIGN_RIGHT,
        )
        curr_y += 24.0

        # Questions Rendering
        sorted_questions = sorted(group.questions, key=lambda q: q.question_order)
        for idx, q in enumerate(sorted_questions, start=1):
            # Estimate height needed for this question
            q_type = (q.question_type or "").lower()
            needed_height = 40.0
            if q_type in ["mcq", "multiple_choice"] and q.options:
                needed_height += len(q.options) * 14.0 + 16.0
            elif q_type in ["short_answer", "essay"]:
                needed_height += 36.0 if q_type == "essay" else 24.0

            # Page break check
            if curr_y + needed_height > max_y:
                page = pdf_doc.new_page(width=page_width, height=page_height)
                curr_y = 50.0
                # Running top header on continued page
                page.insert_text(
                    (margin_x, curr_y - 12.0),
                    f"{exam.title} - {group.group_name} (Continued)",
                    fontsize=8.0,
                    fontname="helv",
                    color=(0.5, 0.5, 0.5),
                )
                page.draw_line((margin_x, curr_y - 8.0), (page_width - margin_x, curr_y - 8.0), color=(0.85, 0.85, 0.85), width=0.5)

            # Question Header & Text
            q_header = f"Q{idx}. [{q.marks:g} pt{'s' if q.marks != 1 else ''}] {q.question_text}"
            q_rect = pymupdf.Rect(margin_x, curr_y, page_width - margin_x, curr_y + 28.0)
            text_align = pymupdf.TEXT_ALIGN_RIGHT if is_rtl else pymupdf.TEXT_ALIGN_LEFT
            page.insert_textbox(
                q_rect,
                q_header,
                fontsize=9.5,
                fontname="helv",
                color=(0.1, 0.1, 0.1),
                align=text_align,
            )
            curr_y += 30.0

            # Render Question Type Controls
            if q_type in ["mcq", "multiple_choice"] and q.options:
                option_labels = ["A", "B", "C", "D", "E", "F"]
                for o_idx, opt in enumerate(q.options):
                    lbl = option_labels[o_idx] if o_idx < len(option_labels) else str(o_idx + 1)
                    clean_opt = re.sub(r"^[A-Fa-f0-9][\:\.\)]\s*", "", str(opt)).strip()
                    opt_str = f"({lbl})  {clean_opt}"
                    opt_rect = pymupdf.Rect(margin_x + 15.0, curr_y, page_width - margin_x, curr_y + 14.0)
                    page.insert_textbox(
                        opt_rect,
                        opt_str,
                        fontsize=8.5,
                        fontname="helv",
                        color=(0.2, 0.2, 0.2),
                        align=text_align,
                    )
                    curr_y += 14.0

                # Student answer marker
                page.insert_text(
                    (margin_x + 15.0, curr_y + 8.0),
                    "Selected Option: [ ______ ]",
                    fontsize=8.0,
                    fontname="helv",
                    color=(0.4, 0.4, 0.4),
                )
                curr_y += 16.0

            elif q_type == "true_false":
                page.insert_text(
                    (margin_x + 15.0, curr_y + 8.0),
                    "[   ] True          [   ] False",
                    fontsize=9.0,
                    fontname="helv",
                    color=(0.2, 0.2, 0.2),
                )
                curr_y += 18.0

            elif q_type == "fill_blank":
                page.insert_text(
                    (margin_x + 15.0, curr_y + 8.0),
                    "Answer: __________________________________________________________________",
                    fontsize=8.5,
                    fontname="helv",
                    color=(0.2, 0.2, 0.2),
                )
                curr_y += 18.0

            elif q_type in ["short_answer", "essay"]:
                line_count = 5 if q_type == "essay" else 2
                for _ in range(line_count):
                    page.draw_line(
                        (margin_x + 10.0, curr_y + 8.0),
                        (page_width - margin_x - 10.0, curr_y + 8.0),
                        color=(0.85, 0.85, 0.85),
                        width=0.6,
                    )
                    curr_y += 12.0
            else:
                page.insert_text(
                    (margin_x + 15.0, curr_y + 8.0),
                    "Response: ________________________________________________________________",
                    fontsize=8.5,
                    fontname="helv",
                    color=(0.2, 0.2, 0.2),
                )
                curr_y += 16.0

            curr_y += 6.0

    def _render_pdf_answer_key(
        self,
        pdf_doc: pymupdf.Document,
        exam: Exam,
        group: ExamGroup,
        include_references: bool,
        is_rtl: bool,
    ):
        """Renders the confidential teacher answer key and scoring rubrics to PDF."""
        page_width, page_height = 595.32, 841.92
        margin_x = 45.0
        max_y = page_height - 50.0

        page = pdf_doc.new_page(width=page_width, height=page_height)
        curr_y = 50.0

        # Confidential Header
        hdr_rect = pymupdf.Rect(margin_x, curr_y, page_width - margin_x, curr_y + 16.0)
        page.insert_textbox(
            hdr_rect,
            "CONFIDENTIAL - TEACHER ANSWER KEY & SCORING RUBRICS",
            fontsize=12,
            fontname="helv",
            color=(0.6, 0.1, 0.1),
            align=pymupdf.TEXT_ALIGN_CENTER,
        )
        curr_y += 18.0

        sub_rect = pymupdf.Rect(margin_x, curr_y, page_width - margin_x, curr_y + 14.0)
        page.insert_textbox(
            sub_rect,
            f"{exam.title}   |   Variant: {group.group_name}",
            fontsize=9.5,
            fontname="helv",
            color=(0.3, 0.3, 0.3),
            align=pymupdf.TEXT_ALIGN_CENTER,
        )
        curr_y += 18.0

        page.draw_line((margin_x, curr_y), (page_width - margin_x, curr_y), color=(0.7, 0.2, 0.2), width=1.0)
        curr_y += 14.0

        sorted_questions = sorted(group.questions, key=lambda q: q.question_order)
        for idx, q in enumerate(sorted_questions, start=1):
            if curr_y + 55.0 > max_y:
                page = pdf_doc.new_page(width=page_width, height=page_height)
                curr_y = 50.0
                page.insert_text(
                    (margin_x, curr_y - 12.0),
                    f"{exam.title} - {group.group_name} Answer Key (Continued)",
                    fontsize=8.0,
                    fontname="helv",
                    color=(0.5, 0.5, 0.5),
                )
                page.draw_line((margin_x, curr_y - 8.0), (page_width - margin_x, curr_y - 8.0), color=(0.8, 0.8, 0.8), width=0.5)

            # Item header
            item_header = f"Q{idx} ({q.question_type or 'General'} - {q.marks:g} pt): {q.question_text}"
            page.insert_text(
                (margin_x, curr_y),
                item_header,
                fontsize=8.5,
                fontname="helv",
                color=(0.1, 0.1, 0.1),
            )
            curr_y += 12.0

            ans_text = f"Correct Answer: {q.correct_answer}"
            page.insert_text(
                (margin_x + 10.0, curr_y),
                ans_text,
                fontsize=8.5,
                fontname="helv",
                color=(0.05, 0.45, 0.15),
            )
            curr_y += 12.0

            if q.explanation:
                page.insert_text(
                    (margin_x + 10.0, curr_y),
                    f"Explanation: {q.explanation}",
                    fontsize=8.0,
                    fontname="helv",
                    color=(0.35, 0.35, 0.35),
                )
                curr_y += 11.0

            if include_references:
                prov_str = f"Source: {q.source_document_name or 'N/A'} (Page {q.source_page or 1})"
                if q.source_evidence:
                    prov_str += f' | Citation: "{q.source_evidence}"'
                page.insert_text(
                    (margin_x + 10.0, curr_y),
                    prov_str,
                    fontsize=7.5,
                    fontname="helv",
                    color=(0.5, 0.5, 0.5),
                )
                curr_y += 12.0

            # Subtle item separator
            page.draw_line((margin_x + 10.0, curr_y), (page_width - margin_x - 10.0, curr_y), color=(0.92, 0.92, 0.92), width=0.5)
            curr_y += 8.0

    # -------------------------------------------------------------------------
    # XML / RTL HELPERS
    # -------------------------------------------------------------------------
    @staticmethod
    def _set_p_rtl(paragraph: docx.text.paragraph.Paragraph):
        """Sets bidirectional right-to-left properties on Word OpenXML paragraph."""
        pPr = paragraph._p.get_or_add_pPr()
        bidi = OxmlElement("w:bidi")
        bidi.set(qn("w:val"), "1")
        pPr.append(bidi)

    @staticmethod
    def _set_run_rtl(run: docx.text.run.Run):
        """Sets right-to-left run properties on Word OpenXML run."""
        rPr = run._r.get_or_add_rPr()
        rtl = OxmlElement("w:rtl")
        rtl.set(qn("w:val"), "1")
        rPr.append(rtl)

    @staticmethod
    def _set_tbl_rtl(table: docx.table.Table):
        """Sets visual right-to-left column layout on Word OpenXML table."""
        tblPr = table._tbl.tblPr
        bidi_vis = OxmlElement("w:bidiVisual")
        tblPr.append(bidi_vis)


# Singleton instance
_export_service: Optional[ExamExportService] = None


def get_export_service() -> ExamExportService:
    global _export_service
    if _export_service is None:
        _export_service = ExamExportService()
    return _export_service
