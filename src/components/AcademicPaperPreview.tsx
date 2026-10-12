import React, { useState } from 'react';
import {
  Printer,
  FileText,
  Download,
  ArrowLeft,
  ShieldAlert,
  Award,
  Layers,
  CheckCircle2,
  HelpCircle,
  Eye,
  FileCheck,
} from 'lucide-react';
import { Exam, ExamGroup, Question } from './ExamWorkspace';

interface AcademicPaperPreviewProps {
  exam: Exam;
  activeGroupIndex: number;
  onGroupSelect: (index: number) => void;
  onClose: () => void;
  onExport: (
    format: 'docx' | 'pdf',
    target: 'both' | 'exam' | 'answer_key',
    exportAll: boolean
  ) => void;
}

export function AcademicPaperPreview({
  exam,
  activeGroupIndex,
  onGroupSelect,
  onClose,
  onExport,
}: AcademicPaperPreviewProps) {
  // Preview mode: 'both' | 'exam' | 'answer_key'
  const [viewTarget, setViewTarget] = useState<'both' | 'exam' | 'answer_key'>('both');
  // Scope: 'single' | 'all'
  const [scope, setScope] = useState<'single' | 'all'>('single');

  const isRtl = Boolean(exam.is_rtl);
  const groupsToRender =
    scope === 'all'
      ? exam.groups
      : [exam.groups[activeGroupIndex] || exam.groups[0]].filter(Boolean);

  const handlePrint = async () => {
    // 1. Ensure all custom and web fonts are loaded before opening print dialog
    if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
      try {
        await document.fonts.ready;
      } catch {
        // Continue if font promise fails
      }
    }

    // 2. Ensure React DOM updates and style recalcs have painted before opening print dialog
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(() => {
          try {
            window.print();
          } catch (err) {
            console.error('Print dialog error:', err);
          }
        }, 100);
      });
    });
  };

  return (
    <div className="space-y-6">
      {/* PREVIEW TOOLBAR (Hidden during print) */}
      <div className="no-print bg-white p-4 rounded-2xl border border-stone-200/90 shadow-xs flex flex-wrap items-center justify-between gap-4 sticky top-16 z-20">
        <div className="flex items-center gap-3">
          <button
            onClick={onClose}
            className="p-2 rounded-xl border border-stone-200 text-stone-600 hover:bg-stone-50 transition-all cursor-pointer flex items-center gap-1.5 text-xs font-semibold"
            title="Return to Editor"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to Editor</span>
          </button>

          <div className="h-5 w-px bg-stone-200" />

          <div>
            <h3 className="text-sm font-bold text-stone-900 flex items-center gap-2">
              <Eye className="w-4 h-4 text-[#9D174D]" />
              Academic Examination Sheet Preview
            </h3>
            <p className="text-[11px] text-stone-500">
              Read-only authentic print preview of student papers & confidential answer keys
            </p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center flex-wrap gap-2">
          {/* Target Mode Selector */}
          <div className="flex items-center bg-stone-100 p-1 rounded-xl text-xs font-medium">
            <button
              onClick={() => setViewTarget('both')}
              className={`px-3 py-1 rounded-lg transition-all cursor-pointer ${
                viewTarget === 'both'
                  ? 'bg-white text-stone-900 font-bold shadow-2xs'
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              Paper + Key
            </button>
            <button
              onClick={() => setViewTarget('exam')}
              className={`px-3 py-1 rounded-lg transition-all cursor-pointer ${
                viewTarget === 'exam'
                  ? 'bg-white text-stone-900 font-bold shadow-2xs'
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              Student Paper
            </button>
            <button
              onClick={() => setViewTarget('answer_key')}
              className={`px-3 py-1 rounded-lg transition-all cursor-pointer ${
                viewTarget === 'answer_key'
                  ? 'bg-white text-stone-900 font-bold shadow-2xs'
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              Answer Key
            </button>
          </div>

          <div className="h-5 w-px bg-stone-200" />

          {/* Scope Selector: Single Group vs All Groups */}
          <div className="flex items-center bg-stone-100 p-1 rounded-xl text-xs font-medium">
            <button
              onClick={() => setScope('single')}
              className={`px-2.5 py-1 rounded-lg transition-all cursor-pointer ${
                scope === 'single'
                  ? 'bg-white text-stone-900 font-bold shadow-2xs'
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              Current Group
            </button>
            <button
              onClick={() => setScope('all')}
              className={`px-2.5 py-1 rounded-lg transition-all cursor-pointer ${
                scope === 'all'
                  ? 'bg-white text-stone-900 font-bold shadow-2xs'
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              All {exam.groups_count} Groups (Compiled)
            </button>
          </div>

          <div className="h-5 w-px bg-stone-200" />

          {/* Print Button */}
          <button
            onClick={handlePrint}
            className="px-3 py-1.5 rounded-xl border border-stone-200 text-stone-700 hover:bg-stone-50 font-bold text-xs flex items-center gap-1.5 cursor-pointer shadow-xs"
          >
            <Printer className="w-3.5 h-3.5 text-stone-600" />
            <span>Print Sheet</span>
          </button>

          {/* Phase 4.2 Export Triggers */}
          <button
            onClick={() => onExport('docx', viewTarget, scope === 'all')}
            className="px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs flex items-center gap-1.5 cursor-pointer shadow-xs"
          >
            <FileText className="w-3.5 h-3.5" />
            <span>DOCX</span>
          </button>
          <button
            onClick={() => onExport('pdf', viewTarget, scope === 'all')}
            className="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs flex items-center gap-1.5 cursor-pointer shadow-xs"
          >
            <Download className="w-3.5 h-3.5" />
            <span>PDF</span>
          </button>
        </div>
      </div>

      {/* DYNAMIC GROUP TABS (Visible when scope is single, hidden in print) */}
      {scope === 'single' && (
        <div className="no-print flex items-center gap-2 border-b border-stone-200 pb-2 overflow-x-auto">
          {exam.groups.map((grp, idx) => {
            const isSelected = activeGroupIndex === idx;
            return (
              <button
                key={grp.id}
                onClick={() => onGroupSelect(idx)}
                className={`px-4 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 shrink-0 ${
                  isSelected
                    ? 'bg-stone-900 text-white shadow-xs'
                    : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                }`}
              >
                <Layers className="w-3 h-3 text-pink-400" />
                <span>{grp.group_name}</span>
                <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-white/20">
                  {grp.questions.length} Qs
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* ACADEMIC PAPER SHEETS CONTAINER */}
      <div className="space-y-12">
        {groupsToRender.map((group, gIdx) => {
          const groupMarks = group.questions.reduce((sum, q) => sum + (q.marks || 0), 0);
          const sortedQuestions = [...group.questions].sort(
            (a, b) => a.question_order - b.question_order
          );

          return (
            <div key={group.id} className="space-y-8">
              {/* 1. STUDENT EXAMINATION PAPER SHEET */}
              {(viewTarget === 'both' || viewTarget === 'exam') && (
                <div
                  dir={isRtl ? 'rtl' : 'ltr'}
                  className={`paper-sheet ${gIdx > 0 ? 'print-page-break' : ''} bg-white rounded-2xl border border-stone-300 shadow-lg p-10 max-w-4xl mx-auto space-y-6 text-stone-900 font-serif leading-relaxed`}
                >
                  {/* Institutional Header */}
                  <div className="text-center space-y-1 border-b border-stone-200 pb-4">
                    <h2 className="text-base font-bold tracking-wide uppercase text-stone-800">
                      {exam.institution || 'ACADEMIC INSTITUTION'}
                    </h2>
                    <h1 className="text-xl font-black text-stone-950 font-sans tracking-tight">
                      {exam.title}
                    </h1>
                    <div className="text-xs text-stone-600 italic flex items-center justify-center gap-3">
                      <span>Subject: {exam.subject}</span>
                      {exam.grade_level && <span>• Class: {exam.grade_level}</span>}
                      {exam.teacher_name && <span>• Instructor: {exam.teacher_name}</span>}
                    </div>
                  </div>

                  {/* Student Details Grid (2 rows x 4 columns) */}
                  <div className="border border-stone-300 rounded-lg text-xs p-3 font-sans grid grid-cols-2 md:grid-cols-4 gap-2 bg-stone-50/50">
                    <div className="col-span-2">
                      <span className="text-stone-500">Student Name:</span>{' '}
                      <span className="border-b border-stone-400 inline-block w-48"></span>
                    </div>
                    <div className="col-span-2">
                      <span className="text-stone-500">Roll / Seat No:</span>{' '}
                      <span className="border-b border-stone-400 inline-block w-32"></span>
                    </div>
                    <div>
                      <span className="text-stone-500">Date:</span>{' '}
                      <span className="font-semibold text-stone-800">
                        {exam.exam_date || new Date().toISOString().split('T')[0]}
                      </span>
                    </div>
                    <div>
                      <span className="text-stone-500">Time:</span>{' '}
                      <span className="font-semibold text-stone-800">
                        {exam.duration_minutes} Mins
                      </span>
                    </div>
                    <div>
                      <span className="text-stone-500">Max Marks:</span>{' '}
                      <span className="font-bold text-stone-900">{groupMarks} pts</span>
                    </div>
                    <div>
                      <span className="text-stone-500">Variant:</span>{' '}
                      <span className="font-bold text-[#9D174D] bg-pink-100/70 px-2 py-0.5 rounded">
                        {group.group_name}
                      </span>
                    </div>
                  </div>

                  {/* General Instructions Box */}
                  <div className="p-3 bg-stone-100/70 rounded-lg border border-stone-200 text-xs text-stone-700 font-sans space-y-1">
                    <div className="font-bold text-stone-900 uppercase tracking-wider text-[11px]">
                      General Instructions:
                    </div>
                    <ol className="list-decimal list-inside space-y-0.5 text-[11px] text-stone-600">
                      <li>Check that this paper contains all questions for your designated examination group.</li>
                      <li>Write all answers clearly in the spaces provided below.</li>
                      <li>Ensure your name and seat number are properly recorded above.</li>
                      <li>Unauthorized devices, notes, or calculators are strictly prohibited.</li>
                    </ol>
                  </div>

                  {/* Questions Section */}
                  <div className="space-y-6 pt-2">
                    {sortedQuestions.map((q, idx) => {
                      const qType = (q.question_type || '').toLowerCase();
                      const optionLetters = ['A', 'B', 'C', 'D', 'E', 'F'];

                      return (
                        <div key={q.id} className="paper-question-item space-y-2 pb-4 border-b border-stone-100 last:border-b-0">
                          {/* Question Number, Text & Marks */}
                          <div className="flex items-start justify-between gap-3 text-sm">
                            <div className="flex items-start gap-2">
                              <span className="font-bold text-stone-900 font-sans">
                                Q{idx + 1}.
                              </span>
                              <p className="text-stone-900 break-words leading-relaxed">{q.question_text}</p>
                            </div>
                            <span className="text-xs font-bold font-sans px-2 py-0.5 bg-stone-100 text-stone-700 rounded shrink-0">
                              [{q.marks} pt{q.marks !== 1 ? 's' : ''}]
                            </span>
                          </div>

                          {/* Question Type Presentation */}
                          {qType === 'mcq' && q.options && (
                            <div className="space-y-1.5 pl-6 pt-1 font-sans text-xs">
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                {q.options.map((opt, oIdx) => {
                                  const lbl =
                                    optionLetters[oIdx] || String(oIdx + 1);
                                  // Clean leading A: or (A) if present
                                  const cleanOpt = String(opt)
                                    .replace(/^[A-Fa-f0-9][\:\.\)]\s*/, '')
                                    .trim();

                                  return (
                                    <div
                                      key={oIdx}
                                      className="flex items-center gap-2 p-1.5 rounded border border-stone-200/70 bg-stone-50/30"
                                    >
                                      <span className="font-bold text-stone-700">
                                        ({lbl})
                                      </span>
                                      <span className="text-stone-800 break-words">{cleanOpt}</span>
                                    </div>
                                  );
                                })}
                              </div>
                              <div className="pt-2 text-[11px] text-stone-500 italic">
                                Selected Option: [ &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; ]
                              </div>
                            </div>
                          )}

                          {qType === 'true_false' && (
                            <div className="pl-6 pt-1 font-sans text-xs flex items-center gap-6">
                              <div className="flex items-center gap-2">
                                <div className="w-4 h-4 border border-stone-400 rounded-sm"></div>
                                <span>True</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <div className="w-4 h-4 border border-stone-400 rounded-sm"></div>
                                <span>False</span>
                              </div>
                            </div>
                          )}

                          {qType === 'fill_blank' && (
                            <div className="pl-6 pt-2 font-sans text-xs">
                              <span className="text-stone-500">Answer:</span>{' '}
                              <span className="border-b border-stone-400 inline-block w-full max-w-md"></span>
                            </div>
                          )}

                          {qType === 'short_answer' && (
                            <div className="pl-6 pt-2 space-y-2">
                              <div className="border-b border-dashed border-stone-300 h-4 w-full"></div>
                              <div className="border-b border-dashed border-stone-300 h-4 w-full"></div>
                              <div className="border-b border-dashed border-stone-300 h-4 w-full"></div>
                            </div>
                          )}

                          {qType === 'essay' && (
                            <div className="pl-6 pt-2 space-y-2">
                              {Array.from({ length: 6 }).map((_, lIdx) => (
                                <div
                                  key={lIdx}
                                  className="border-b border-dashed border-stone-300 h-4 w-full"
                                ></div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* End of Student Paper Notice */}
                  <div className="text-center pt-6 border-t border-stone-200 text-xs font-sans text-stone-400 uppercase tracking-widest">
                    --- END OF EXAMINATION PAPER ({group.group_name}) ---
                  </div>
                </div>
              )}

              {/* 2. TEACHER ANSWER KEY & SCORING RUBRICS (Hard page break in print when following paper or in subsequent groups) */}
              {(viewTarget === 'both' || viewTarget === 'answer_key') && (
                <div
                  dir={isRtl ? 'rtl' : 'ltr'}
                  className={`paper-sheet ${viewTarget === 'both' || gIdx > 0 ? 'print-page-break' : ''} bg-white rounded-2xl border border-rose-200 shadow-lg p-10 max-w-4xl mx-auto space-y-6 text-stone-900 font-sans`}
                >
                  {/* Confidential Header */}
                  <div className="border-b-2 border-rose-600 pb-3 flex items-center justify-between">
                    <div>
                      <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-rose-100 text-rose-800 font-bold text-xs">
                        <ShieldAlert className="w-3.5 h-3.5" />
                        CONFIDENTIAL - OFFICIAL TEACHER ANSWER KEY
                      </div>
                      <h2 className="text-base font-bold text-stone-900 mt-1">
                        {exam.title} • {group.group_name} Scoring Rubric
                      </h2>
                    </div>
                    <div className="text-right text-xs text-stone-500">
                      <div>Total Questions: {sortedQuestions.length}</div>
                      <div className="font-bold text-rose-700">Total Marks: {groupMarks} pts</div>
                    </div>
                  </div>

                  {/* Structured Answer Key Table */}
                  <div className="border border-stone-200 rounded-xl overflow-hidden print:overflow-visible print:border-none">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead className="bg-stone-100/80 border-b border-stone-200 text-stone-700 font-bold">
                        <tr>
                          <th className="p-2.5 w-12 text-center">Q#</th>
                          <th className="p-2.5 w-24">Type</th>
                          <th className="p-2.5 w-16 text-center">Marks</th>
                          <th className="p-2.5 w-40">Correct Answer</th>
                          <th className="p-2.5">Explanation</th>
                          <th className="p-2.5 w-48 bg-rose-50/50">Source Provenance</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-stone-200 text-stone-800">
                        {sortedQuestions.map((q, idx) => (
                          <tr key={q.id} className="hover:bg-stone-50/40">
                            <td className="p-2.5 text-center font-bold text-stone-900">
                              Q{idx + 1}
                            </td>
                            <td className="p-2.5 capitalize text-stone-600">
                              {q.question_type?.replace('_', ' ')}
                            </td>
                            <td className="p-2.5 text-center font-bold text-emerald-700">
                              {q.marks} pt
                            </td>
                            <td className="p-2.5 font-bold text-emerald-800 break-words">
                              {q.correct_answer}
                            </td>
                            <td className="p-2.5 text-stone-600 text-[11px] break-words">
                              {q.explanation || '—'}
                            </td>
                            <td className="p-2.5 text-[11px] text-stone-500 bg-rose-50/30">
                              {q.source_document_name && (
                                <div className="font-semibold text-stone-700">
                                  {q.source_document_name}
                                  {q.source_page && ` (P. ${q.source_page})`}
                                </div>
                              )}
                              {q.source_evidence && (
                                <div className="italic text-stone-500 mt-0.5 break-words">
                                  "{q.source_evidence}"
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Confidentiality Footer */}
                  <div className="text-center pt-4 border-t border-stone-200 text-[11px] text-rose-700 font-medium">
                    Strictly confidential document. Not to be distributed to students before examination grading is concluded.
                  </div>
                </div>
              )}

              {/* Page break between groups when compiled */}
              {scope === 'all' && gIdx < groupsToRender.length - 1 && (
                <div className="print-page-break no-print border-t-2 border-dashed border-stone-300 my-8 text-center text-xs text-stone-400">
                  --- End of {group.group_name} ---
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
