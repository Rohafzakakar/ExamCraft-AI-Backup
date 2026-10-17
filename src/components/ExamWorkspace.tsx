import React, { useState, useEffect } from 'react';
import {
  Upload,
  FileText,
  CheckCircle2,
  Sparkles,
  Layers,
  HelpCircle,
  Edit2,
  Trash2,
  Save,
  X,
  BookOpen,
  ArrowRight,
  ShieldCheck,
  Award,
  Globe,
  Shuffle,
  AlertTriangle,
  RotateCcw,
  Download,
  FileDown,
  Eye,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import { AcademicPaperPreview } from './AcademicPaperPreview';
import { authFetch } from '../utils/auth';

interface DocumentInfo {
  id: string;
  filename: string;
  file_type: string;
  total_pages: number;
  detected_language: string;
  is_rtl: boolean;
  chunks_count: number;
  status: string;
}

export interface Question {
  id: string;
  exam_id: string;
  group_id: string;
  question_order: number;
  question_type: string;
  question_text: string;
  options?: string[] | null;
  correct_answer: string;
  explanation?: string | null;
  marks: number;
  difficulty: string;
  bloom_level?: string | null;
  source_document_name: string;
  source_page: number;
  source_chapter?: string | null;
  source_section?: string | null;
  source_chunk_id?: string | null;
  source_evidence: string;
}

export interface ExamGroup {
  id: string;
  exam_id: string;
  group_name: string;
  group_order: number;
  questions_count: number;
  questions: Question[];
}

export interface Exam {
  id: string;
  title: string;
  subject: string;
  institution?: string | null;
  faculty?: string | null;
  teacher_name?: string;
  grade_level?: string;
  exam_date?: string;
  duration_minutes: number;
  total_marks: number;
  language: string;
  is_rtl: boolean;
  bloom_enabled: boolean;
  status: string;
  groups_count: number;
  questions_count: number;
  groups: ExamGroup[];
}

interface AnswerKeyItem {
  question_number: number;
  question_type: string;
  correct_answer: string;
  explanation?: string;
  marks: number;
  source_reference: string;
  source_page: number;
}

interface AnswerKeyGroup {
  id: string;
  exam_id: string;
  group_id: string;
  group_name: string;
  items: AnswerKeyItem[];
}

export interface ExamWorkspaceProps {
  isLlmConfigured: boolean;
  externalActiveExamId?: string | null;
  onOpenHistory?: () => void;
  onExamsUpdated?: (exams: Exam[]) => void;
}

export function ExamWorkspace({
  isLlmConfigured,
  externalActiveExamId,
  onOpenHistory,
  onExamsUpdated,
}: ExamWorkspaceProps) {
  // Step navigation: 1: Upload, 2: Configure & Generate, 3: Review & Groups
  const [step, setStep] = useState<number>(1);
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<DocumentInfo | null>(null);
  const [selectedPages, setSelectedPages] = useState<string>('all');
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Exam Configuration State (Supports 1-10 groups)
  const [title, setTitle] = useState<string>('Cell Biology Midterm Examination');
  const [subject, setSubject] = useState<string>('Molecular & Cellular Biology');
  const [institution, setInstitution] = useState<string>('');
  const [faculty, setFaculty] = useState<string>('');
  const [groupsCount, setGroupsCount] = useState<number>(3);
  const [durationMinutes, setDurationMinutes] = useState<number>(60);
  const [mcqCount, setMcqCount] = useState<number>(2);
  const [tfCount, setTfCount] = useState<number>(1);
  const [fillBlankCount, setFillBlankCount] = useState<number>(0);
  const [shortCount, setShortCount] = useState<number>(1);
  const [essayCount, setEssayCount] = useState<number>(0);
  const [bloomEnabled, setBloomEnabled] = useState<boolean>(true);

  const totalQuestions = mcqCount + tfCount + fillBlankCount + shortCount + essayCount;

  const getGroupLabelText = (count: number) => {
    if (count <= 1) return '1 Group (Group A)';
    const endLetter = String.fromCharCode(65 + count - 1);
    return `${count} Groups (Group A–${endLetter})`;
  };

  // Generation state
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [activeExam, setActiveExam] = useState<Exam | null>(null);
  const [activeGroupIndex, setActiveGroupIndex] = useState<number>(0);
  const [answerKeys, setAnswerKeys] = useState<AnswerKeyGroup[]>([]);
  const [viewMode, setViewMode] = useState<'questions' | 'answer_keys'>('questions');
  const [workspaceView, setWorkspaceView] = useState<'editor' | 'preview'>('editor');

  // Export engine state
  const [showExportModal, setShowExportModal] = useState<boolean>(false);
  const [exportTarget, setExportTarget] = useState<'both' | 'exam' | 'answer_key'>('both');
  const [exportScope, setExportScope] = useState<'current' | 'all'>('current');
  const [includeProvenance, setIncludeProvenance] = useState<boolean>(true);

  const handleExport = (format: 'docx' | 'pdf') => {
    if (!activeExam) return;
    const currentGroupId = exportScope === 'all' ? '' : activeExam.groups[activeGroupIndex]?.id || '';
    let url = `/api/exams/${activeExam.id}/export/${format}?target=${exportTarget}&include_references=${includeProvenance}`;
    if (currentGroupId) {
      url += `&group_id=${currentGroupId}`;
    }
    window.location.href = url;
  };

  // Question editing state
  const [editingQuestionId, setEditingQuestionId] = useState<string | null>(null);
  const [editText, setEditText] = useState<string>('');
  const [editMarks, setEditMarks] = useState<number>(1);
  const [editOptions, setEditOptions] = useState<string[]>([]);
  const [editCorrectAnswer, setEditCorrectAnswer] = useState<string>('');
  const [editExplanation, setEditExplanation] = useState<string>('');
  const [isSavingEdit, setIsSavingEdit] = useState<boolean>(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Question delete confirmation state
  const [deletingQuestion, setDeletingQuestion] = useState<Question | null>(null);
  const [isDeletingQuestion, setIsDeletingQuestion] = useState<boolean>(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const loadExamById = async (examId: string) => {
    try {
      const res = await authFetch(`/api/exams/${examId}`);
      if (res.ok) {
        const data = await res.json();
        setActiveExam(data);
        setActiveGroupIndex(0);
        setStep(3);
        loadAnswerKeys(data.id);
      }
    } catch (e) {
      console.error('Failed to load exam by id:', e);
    }
  };

  // React to external active exam changes
  useEffect(() => {
    if (externalActiveExamId) {
      loadExamById(externalActiveExamId);
    }
  }, [externalActiveExamId]);

  // Load existing documents & exams on mount and listen to auth changes
  useEffect(() => {
    fetchDocuments();
    fetchExams();

    const handleAuthChange = () => {
      fetchDocuments();
      fetchExams();
    };

    window.addEventListener('examcraft_auth_changed', handleAuthChange);
    window.addEventListener('examcraft_auth_expired', handleAuthChange);
    return () => {
      window.removeEventListener('examcraft_auth_changed', handleAuthChange);
      window.removeEventListener('examcraft_auth_expired', handleAuthChange);
    };
  }, []);

  const fetchDocuments = async () => {
    try {
      const res = await authFetch('/api/documents');
      if (res.ok) {
        const data = await res.json();
        setDocuments(data);
        if (data.length > 0 && !selectedDoc) {
          setSelectedDoc(data[0]);
        }
      }
    } catch (e) {
      console.error('Failed to load documents:', e);
    }
  };

  const fetchExams = async () => {
    try {
      const res = await authFetch('/api/exams');
      if (res.ok) {
        const data = await res.json();
        if (onExamsUpdated) {
          onExamsUpdated(data);
        }
        if (data.length > 0 && !activeExam) {
          setActiveExam(data[0]);
          loadAnswerKeys(data[0].id);
        }
      }
    } catch (e) {
      console.error('Failed to load exams:', e);
    }
  };

  const loadAnswerKeys = async (examId: string) => {
    try {
      const res = await authFetch(`/api/exams/${examId}/answer-key`);
      if (res.ok) {
        const data = await res.json();
        setAnswerKeys(data);
      }
    } catch (e) {
      console.error('Failed to load answer keys:', e);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setUploadError(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('session_id', 'teacher_session');

    try {
      const res = await authFetch('/api/documents/upload', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Upload failed');
      }

      const newDoc = await res.json();
      setDocuments((prev) => [newDoc, ...prev]);
      setSelectedDoc(newDoc);
      setStep(2);
    } catch (err: any) {
      setUploadError(err.message || 'Failed to upload document');
    } finally {
      setIsUploading(false);
    }
  };

  const handleGenerateExam = async () => {
    if (!selectedDoc) {
      setGenerationError('Please select or upload a document first.');
      return;
    }

    if (totalQuestions <= 0) {
      setGenerationError('Please specify at least 1 question across the question types.');
      return;
    }

    setIsGenerating(true);
    setGenerationError(null);

    let parsedPages: number[] | null = null;
    if (selectedPages !== 'all') {
      parsedPages = selectedPages
        .split(',')
        .map((p) => parseInt(p.trim(), 10))
        .filter((p) => !isNaN(p));
    }

    const payload = {
      document_id: selectedDoc.id,
      selected_pages: parsedPages,
      title: title || 'Examination',
      subject: subject || 'General Subject',
      institution: institution.trim() || undefined,
      faculty: faculty.trim() || undefined,
      teacher_name: 'Instructor',
      grade_level: 'Undergraduate',
      duration_minutes: durationMinutes,
      total_marks: 100.0,
      language: selectedDoc.detected_language || 'en',
      is_rtl: selectedDoc.is_rtl,
      bloom_enabled: bloomEnabled,
      groups_count: Math.min(10, Math.max(1, groupsCount)),
      difficulty_distribution: { easy: 40, medium: 40, hard: 20 },
      question_types_config: {
        mcq: Math.max(0, mcqCount),
        true_false: Math.max(0, tfCount),
        fill_blank: Math.max(0, fillBlankCount),
        short_answer: Math.max(0, shortCount),
        essay: Math.max(0, essayCount),
      },
    };

    try {
      const res = await authFetch('/api/exams/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.detail || 'Generation failed');
      }

      const examData: Exam = await res.json();
      setActiveExam(examData);
      setActiveGroupIndex(0);
      setStep(3);
      loadAnswerKeys(examData.id);
      fetchExams();
    } catch (err: any) {
      setGenerationError(err.message || 'Generation failed');
    } finally {
      setIsGenerating(false);
    }
  };

  const normalizeCorrectAnswer = (correct: string, options?: string[] | null) => {
    if (!options || options.length === 0) return correct;
    const exact = options.find((opt) => opt === correct);
    if (exact) return exact;
    const letters = ['A', 'B', 'C', 'D', 'E'];
    for (let idx = 0; idx < options.length; idx++) {
      const l = letters[idx];
      if (correct.trim() === l || correct.startsWith(`${l})`) || correct.startsWith(`${l}.`)) {
        return options[idx];
      }
    }
    const sub = options.find((opt) => correct.includes(opt) || opt.includes(correct));
    if (sub) return sub;
    return options[0] || correct;
  };

  const handleStartEdit = (q: Question) => {
    setEditingQuestionId(q.id);
    setEditText(q.question_text);
    setEditMarks(q.marks);
    const initialOptions = q.options && q.options.length > 0
      ? [...q.options]
      : (q.question_type === 'mcq' ? ['Option A', 'Option B', 'Option C', 'Option D'] : []);
    setEditOptions(initialOptions);
    setEditCorrectAnswer(normalizeCorrectAnswer(q.correct_answer || '', initialOptions));
    setEditExplanation(q.explanation || '');
    setEditError(null);
  };

  const handleSaveEdit = async (questionId: string) => {
    if (!activeExam) return;
    setIsSavingEdit(true);
    setEditError(null);

    try {
      const payload: any = {
        question_text: editText,
        marks: editMarks,
        explanation: editExplanation,
      };

      if (editOptions && editOptions.length > 0) {
        payload.options = editOptions;
        payload.correct_answer = editCorrectAnswer;
      } else if (editCorrectAnswer) {
        payload.correct_answer = editCorrectAnswer;
      }

      const res = await authFetch(`/api/exams/${activeExam.id}/questions/${questionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const updatedQ: Question = await res.json();
        // Fetch fresh exam state to guarantee synchronization across all groups and variants
        const examRes = await authFetch(`/api/exams/${activeExam.id}`);
        if (examRes.ok) {
          const freshExam = await examRes.json();
          setActiveExam(freshExam);
        } else {
          setActiveExam((prev) => {
            if (!prev) return prev;
            const newGroups = prev.groups.map((g) => {
              const hasQ = g.questions.some((q) => q.id === questionId);
              if (hasQ) {
                return {
                  ...g,
                  questions: g.questions.map((q) => (q.id === questionId ? updatedQ : q)),
                };
              }
              return g;
            });
            const newTotal = newGroups[0]?.questions.reduce((sum, q) => sum + (q.marks || 0), 0) || prev.total_marks;
            return { ...prev, groups: newGroups, total_marks: newTotal };
          });
        }
        setEditingQuestionId(null);
        setEditError(null);
        await loadAnswerKeys(activeExam.id);
      } else {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || 'Failed to save question edits');
      }
    } catch (e: any) {
      console.error('Failed to update question:', e);
      setEditError(e.message || 'Failed to update question');
    } finally {
      setIsSavingEdit(false);
    }
  };

  const handleDeleteQuestion = async () => {
    if (!activeExam || !deletingQuestion) return;
    setIsDeletingQuestion(true);
    setDeleteError(null);

    try {
      const res = await authFetch(`/api/exams/${activeExam.id}/questions/${deletingQuestion.id}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        const data = await res.json();
        // Fetch fresh exam state from server to ensure perfect synchronization across all groups and variants
        const examRes = await authFetch(`/api/exams/${activeExam.id}`);
        if (examRes.ok) {
          const freshExam = await examRes.json();
          setActiveExam(freshExam);
        } else {
          // Fallback optimistic update using response metrics
          setActiveExam((prev) => {
            if (!prev) return prev;
            const updatedGroups = prev.groups.map((g) => {
              const filtered = g.questions.filter((q) => q.id !== deletingQuestion.id && q.question_text !== deletingQuestion.question_text);
              const resequenced = filtered.map((q, idx) => ({ ...q, question_order: idx + 1 }));
              return {
                ...g,
                questions: resequenced,
                questions_count: resequenced.length,
              };
            });
            const newTotalCount = updatedGroups.reduce((acc, g) => acc + g.questions.length, 0);
            return {
              ...prev,
              groups: updatedGroups,
              questions_count: newTotalCount,
              total_marks: data.new_total_marks ?? prev.total_marks,
            };
          });
        }
        await loadAnswerKeys(activeExam.id);
        setDeletingQuestion(null);
        fetchExams();
      } else {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || 'Failed to delete question from exam.');
      }
    } catch (err: any) {
      console.error('Delete question error:', err);
      setDeleteError(err.message || 'Failed to delete question');
    } finally {
      setIsDeletingQuestion(false);
    }
  };

  const currentGroup = activeExam?.groups?.[activeGroupIndex] || null;

  return (
    <div className="space-y-6">
      {/* Workflow Navigation Pills */}
      <div className="no-print flex items-center gap-2 border-b border-stone-200/80 pb-4">
        <button
          onClick={() => setStep(1)}
          className={`px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 transition-all cursor-pointer ${
            step === 1
              ? 'bg-[#9D174D] text-white shadow-xs'
              : 'bg-stone-100 text-stone-600 hover:bg-stone-200/80'
          }`}
        >
          <span className="w-5 h-5 rounded-full bg-white/20 flex items-center justify-center text-[10px]">
            1
          </span>
          Upload & Select Document
        </button>

        <ArrowRight className="w-3.5 h-3.5 text-stone-400" />

        <button
          onClick={() => setStep(2)}
          className={`px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 transition-all cursor-pointer ${
            step === 2
              ? 'bg-[#9D174D] text-white shadow-xs'
              : 'bg-stone-100 text-stone-600 hover:bg-stone-200/80'
          }`}
        >
          <span className="w-5 h-5 rounded-full bg-white/20 flex items-center justify-center text-[10px]">
            2
          </span>
          Exam & 3-Group Configuration
        </button>

        <ArrowRight className="w-3.5 h-3.5 text-stone-400" />

        <button
          onClick={() => activeExam && setStep(3)}
          disabled={!activeExam}
          className={`px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 transition-all cursor-pointer ${
            step === 3
              ? 'bg-[#9D174D] text-white shadow-xs'
              : activeExam
              ? 'bg-stone-100 text-stone-600 hover:bg-stone-200/80'
              : 'bg-stone-50 text-stone-300 cursor-not-allowed'
          }`}
        >
          <span className="w-5 h-5 rounded-full bg-white/20 flex items-center justify-center text-[10px]">
            3
          </span>
          Review Groups & Answer Keys
        </button>
      </div>

      {/* STEP 1: Upload & Select Document */}
      {step === 1 && (
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-2xl border border-stone-200/80 shadow-xs space-y-4">
            <h3 className="text-sm font-bold text-stone-900 flex items-center gap-2">
              <Upload className="w-4 h-4 text-[#9D174D]" />
              Upload Educational Reference Document (PDF or DOCX)
            </h3>
            <p className="text-xs text-stone-500">
              ExamCraft AI strictly derives all examination questions directly from your uploaded
              curriculum or syllabus materials.
            </p>

            <div className="border-2 border-dashed border-stone-200 hover:border-[#9D174D]/50 rounded-2xl p-8 text-center transition-all bg-stone-50/50 hover:bg-pink-50/20">
              <input
                type="file"
                id="doc-upload-input"
                accept=".pdf,.docx"
                onChange={handleFileUpload}
                disabled={isUploading}
                className="hidden"
              />
              <label
                htmlFor="doc-upload-input"
                className="cursor-pointer flex flex-col items-center justify-center gap-2"
              >
                <div className="w-12 h-12 rounded-2xl bg-pink-50 text-[#9D174D] flex items-center justify-center mb-1">
                  <Upload className="w-6 h-6" />
                </div>
                <span className="text-xs font-semibold text-stone-800">
                  {isUploading ? 'Parsing & Indexing Document...' : 'Click to Upload PDF or DOCX'}
                </span>
                <span className="text-[11px] text-stone-400">
                  Supports English, Dari, Pashto, Arabic, and multilingual materials
                </span>
              </label>
            </div>

            {uploadError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-700 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{uploadError}</span>
              </div>
            )}
          </div>

          {/* List of Loaded Documents */}
          {documents.length > 0 && (
            <div className="bg-white p-6 rounded-2xl border border-stone-200/80 shadow-xs space-y-4">
              <h4 className="text-xs font-bold text-stone-800 uppercase tracking-wider">
                Available Grounding Documents ({documents.length})
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {documents.map((doc) => {
                  const isSelected = selectedDoc?.id === doc.id;
                  return (
                    <div
                      key={doc.id}
                      onClick={() => {
                        setSelectedDoc(doc);
                        setTitle(`${doc.filename.replace(/\.[^/.]+$/, '')} Examination`);
                      }}
                      className={`p-4 rounded-xl border text-left cursor-pointer transition-all ${
                        isSelected
                          ? 'border-[#9D174D] bg-pink-50/40 ring-1 ring-[#9D174D]'
                          : 'border-stone-200 hover:border-stone-300 bg-white'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <FileText
                            className={`w-4 h-4 ${isSelected ? 'text-[#9D174D]' : 'text-stone-400'}`}
                          />
                          <span className="text-xs font-bold text-stone-900 truncate max-w-[220px]">
                            {doc.filename}
                          </span>
                        </div>
                        {isSelected && (
                          <span className="px-2 py-0.5 rounded-full bg-[#9D174D] text-white text-[10px] font-bold">
                            Selected
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-3 text-[11px] text-stone-500">
                        <span>Pages: {doc.total_pages}</span>
                        <span>Chunks: {doc.chunks_count}</span>
                        <span className="flex items-center gap-1 font-mono uppercase text-[10px] bg-stone-100 px-1.5 py-0.5 rounded">
                          <Globe className="w-2.5 h-2.5" />
                          {doc.detected_language}
                          {doc.is_rtl ? ' (RTL)' : ''}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {selectedDoc && (
                <div className="pt-2 flex justify-end">
                  <button
                    onClick={() => setStep(2)}
                    className="px-5 py-2.5 bg-[#9D174D] hover:bg-[#83133E] text-white text-xs font-semibold rounded-xl flex items-center gap-2 shadow-xs cursor-pointer"
                  >
                    <span>Proceed to Exam Configuration</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* STEP 2: Configure & Generate */}
      {step === 2 && (
        <div className="bg-white p-6 md:p-8 rounded-2xl border border-stone-200/80 shadow-xs space-y-6">
          <div className="flex items-center justify-between border-b border-stone-100 pb-4">
            <div>
              <h3 className="text-base font-bold text-stone-900">
                Examination Specification & Psychometrics
              </h3>
              <p className="text-xs text-stone-500">
                Derived exclusively from: <span className="font-semibold text-stone-800">{selectedDoc?.filename}</span>
              </p>
            </div>
            {selectedDoc?.is_rtl && (
              <span className="px-2.5 py-1 rounded-full bg-amber-50 border border-amber-200 text-amber-800 text-xs font-semibold flex items-center gap-1">
                <Globe className="w-3 h-3" /> Right-to-Left (RTL) Active
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-stone-700 mb-1">Exam Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-3 py-2 border border-stone-200 rounded-xl text-xs focus:ring-2 focus:ring-[#9D174D]/30 focus:border-[#9D174D] outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-stone-700 mb-1">Subject</label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="w-full px-3 py-2 border border-stone-200 rounded-xl text-xs focus:ring-2 focus:ring-[#9D174D]/30 focus:border-[#9D174D] outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-stone-700 mb-1">
                  Institution / School / University <span className="text-stone-400 font-normal">(Optional)</span>
                </label>
                <input
                  type="text"
                  value={institution}
                  onChange={(e) => setInstitution(e.target.value)}
                  placeholder="e.g. Kabul University or High School Name"
                  className="w-full px-3 py-2 border border-stone-200 rounded-xl text-xs focus:ring-2 focus:ring-[#9D174D]/30 focus:border-[#9D174D] outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-stone-700 mb-1">
                  Faculty / Department <span className="text-stone-400 font-normal">(Optional)</span>
                </label>
                <input
                  type="text"
                  value={faculty}
                  onChange={(e) => setFaculty(e.target.value)}
                  placeholder="e.g. Faculty of Law or Department of Computer Science"
                  className="w-full px-3 py-2 border border-stone-200 rounded-xl text-xs focus:ring-2 focus:ring-[#9D174D]/30 focus:border-[#9D174D] outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-stone-700 mb-1">
                  Source Page Range
                </label>
                <input
                  type="text"
                  value={selectedPages}
                  onChange={(e) => setSelectedPages(e.target.value)}
                  placeholder="e.g. all or 1,2"
                  className="w-full px-3 py-2 border border-stone-200 rounded-xl text-xs focus:ring-2 focus:ring-[#9D174D]/30 focus:border-[#9D174D] outline-none"
                />
                <span className="text-[10px] text-stone-400 mt-1 block">
                  Leave 'all' to ground on all pages, or specify comma-separated page numbers.
                </span>
              </div>
            </div>

            <div className="space-y-4">
              {/* Dynamic Groups (1-10 Groups) */}
              <div className="p-4 bg-pink-50/50 rounded-xl border border-pink-100 space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-[#9D174D] flex items-center gap-1.5">
                    <Shuffle className="w-3.5 h-3.5" />
                    Anti-Cheating Examination Groups (1–10)
                  </label>
                  <span className="text-xs font-bold text-[#9D174D] bg-pink-100 px-2.5 py-0.5 rounded-full font-mono">
                    {getGroupLabelText(groupsCount)}
                  </span>
                </div>
                <p className="text-[11px] text-stone-600">
                  Generates isomorphic parallel exam variants ({getGroupLabelText(groupsCount)}) with
                  permuted MCQ options and reordered questions to prevent cheating while preserving
                  exact difficulty and grading rubrics.
                </p>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min="1"
                    max="10"
                    value={groupsCount}
                    onChange={(e) => setGroupsCount(Math.min(10, Math.max(1, parseInt(e.target.value, 10) || 1)))}
                    className="w-full accent-[#9D174D] cursor-pointer"
                  />
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={groupsCount}
                    onChange={(e) => setGroupsCount(Math.min(10, Math.max(1, parseInt(e.target.value, 10) || 1)))}
                    className="w-14 px-2 py-1 text-center text-xs font-bold border border-pink-200 rounded-lg bg-white outline-none focus:ring-1 focus:ring-[#9D174D]"
                  />
                </div>
                <div className="flex justify-between text-[10px] font-mono text-stone-500">
                  <span>1 (A)</span>
                  <span>3 (A–C)</span>
                  <span>6 (A–F)</span>
                  <span>10 (A–J)</span>
                </div>
              </div>

              {/* Exact Question Quotas per Group */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-stone-700">
                    Exact Question Quotas (Per Group)
                  </label>
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${totalQuestions > 0 ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                    Total: {totalQuestions} {totalQuestions === 1 ? 'Question' : 'Questions'}
                  </span>
                </div>
                <p className="text-[11px] text-stone-500">
                  Select and enter exact quantities for each question type you need. Set unneeded types to 0.
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <div className="p-2.5 border border-stone-200 rounded-xl text-center bg-stone-50/50">
                    <span className="text-[11px] font-semibold text-stone-700 block">MCQ (4 Options)</span>
                    <span className="text-[9px] text-stone-400 block mb-1">2 marks each</span>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={mcqCount}
                      onChange={(e) => setMcqCount(Math.max(0, parseInt(e.target.value, 10) || 0))}
                      className="w-full text-center text-xs font-bold border border-stone-200 rounded-lg p-1 bg-white focus:ring-1 focus:ring-[#9D174D] outline-none"
                    />
                  </div>
                  <div className="p-2.5 border border-stone-200 rounded-xl text-center bg-stone-50/50">
                    <span className="text-[11px] font-semibold text-stone-700 block">True / False</span>
                    <span className="text-[9px] text-stone-400 block mb-1">1 mark each</span>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={tfCount}
                      onChange={(e) => setTfCount(Math.max(0, parseInt(e.target.value, 10) || 0))}
                      className="w-full text-center text-xs font-bold border border-stone-200 rounded-lg p-1 bg-white focus:ring-1 focus:ring-[#9D174D] outline-none"
                    />
                  </div>
                  <div className="p-2.5 border border-stone-200 rounded-xl text-center bg-stone-50/50">
                    <span className="text-[11px] font-semibold text-stone-700 block">Fill in the Blank</span>
                    <span className="text-[9px] text-stone-400 block mb-1">2 marks each</span>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={fillBlankCount}
                      onChange={(e) => setFillBlankCount(Math.max(0, parseInt(e.target.value, 10) || 0))}
                      className="w-full text-center text-xs font-bold border border-stone-200 rounded-lg p-1 bg-white focus:ring-1 focus:ring-[#9D174D] outline-none"
                    />
                  </div>
                  <div className="p-2.5 border border-stone-200 rounded-xl text-center bg-stone-50/50">
                    <span className="text-[11px] font-semibold text-stone-700 block">Short Answer</span>
                    <span className="text-[9px] text-stone-400 block mb-1">3 marks each</span>
                    <input
                      type="number"
                      min="0"
                      max="50"
                      value={shortCount}
                      onChange={(e) => setShortCount(Math.max(0, parseInt(e.target.value, 10) || 0))}
                      className="w-full text-center text-xs font-bold border border-stone-200 rounded-lg p-1 bg-white focus:ring-1 focus:ring-[#9D174D] outline-none"
                    />
                  </div>
                  <div className="p-2.5 border border-stone-200 rounded-xl text-center bg-stone-50/50 col-span-2 sm:col-span-1">
                    <span className="text-[11px] font-semibold text-stone-700 block">Essay / Long Answer</span>
                    <span className="text-[9px] text-stone-400 block mb-1">5 marks each</span>
                    <input
                      type="number"
                      min="0"
                      max="30"
                      value={essayCount}
                      onChange={(e) => setEssayCount(Math.max(0, parseInt(e.target.value, 10) || 0))}
                      className="w-full text-center text-xs font-bold border border-stone-200 rounded-lg p-1 bg-white focus:ring-1 focus:ring-[#9D174D] outline-none"
                    />
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 pt-2">
                <input
                  type="checkbox"
                  id="bloom-cb"
                  checked={bloomEnabled}
                  onChange={(e) => setBloomEnabled(e.target.checked)}
                  className="rounded text-[#9D174D] focus:ring-[#9D174D]"
                />
                <label htmlFor="bloom-cb" className="text-xs text-stone-700 font-medium">
                  Enforce Bloom's Cognitive Taxonomy (Remember, Understand, Apply, Analyze)
                </label>
              </div>
            </div>
          </div>

          {generationError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-700 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{generationError}</span>
            </div>
          )}

          <div className="flex items-center justify-between pt-4 border-t border-stone-100">
            <button
              onClick={() => setStep(1)}
              className="px-4 py-2 border border-stone-200 rounded-xl text-xs font-semibold text-stone-600 hover:bg-stone-50"
            >
              Back to Documents
            </button>

            <button
              onClick={handleGenerateExam}
              disabled={isGenerating || !isLlmConfigured}
              className={`px-6 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-2 shadow-xs cursor-pointer ${
                isGenerating || !isLlmConfigured
                  ? 'bg-stone-200 text-stone-400 cursor-not-allowed'
                  : 'bg-[#9D174D] hover:bg-[#83133E] text-white'
              }`}
            >
              <Sparkles className="w-4 h-4" />
              <span>
                {isGenerating
                  ? 'Generating via OpenRouter...'
                  : 'Generate 3-Group Exam with OpenRouter (Free)'}
              </span>
            </button>
          </div>
        </div>
      )}

      {/* STEP 3: Review Groups & Answer Keys */}
      {step === 3 && activeExam && (
        <div className="space-y-6">
          {/* Exam Header Summary */}
          <div className={`bg-white p-6 rounded-2xl border border-stone-200/80 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4 ${workspaceView === 'preview' ? 'no-print' : ''}`}>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-stone-900">{activeExam.title}</h3>
                <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-pink-50 text-[#9D174D] font-bold border border-pink-200">
                  {activeExam.groups_count} Groups Generated
                </span>
                {activeExam.is_rtl && (
                  <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200">
                    RTL Script
                  </span>
                )}
              </div>
              <p className="text-xs text-stone-500 mt-1">
                Subject: <span className="font-semibold text-stone-700">{activeExam.subject}</span>
                {activeExam.institution && (
                  <span> | Institution: <span className="font-semibold text-stone-700">{activeExam.institution}</span></span>
                )}
                {activeExam.faculty && (
                  <span> | Faculty/Dept: <span className="font-semibold text-stone-700">{activeExam.faculty}</span></span>
                )}
                {' | Total Questions: '}{activeExam.questions_count} | All Questions Source-Grounded
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setWorkspaceView(workspaceView === 'editor' ? 'preview' : 'editor')}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold cursor-pointer transition-all flex items-center gap-1.5 shadow-xs ${
                  workspaceView === 'preview'
                    ? 'bg-[#9D174D] text-white'
                    : 'bg-pink-50 text-[#9D174D] border border-pink-200 hover:bg-pink-100'
                }`}
              >
                <Eye className="w-3.5 h-3.5" />
                <span>{workspaceView === 'preview' ? 'Return to Editor' : 'Paper Preview & Print'}</span>
              </button>

              {workspaceView === 'editor' && (
                <>
                  <button
                    onClick={() => setViewMode('questions')}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold cursor-pointer transition-all ${
                      viewMode === 'questions'
                        ? 'bg-[#9D174D] text-white shadow-xs'
                        : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                    }`}
                  >
                    Questions View
                  </button>
                  <button
                    onClick={() => setViewMode('answer_keys')}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold cursor-pointer transition-all ${
                      viewMode === 'answer_keys'
                        ? 'bg-[#9D174D] text-white shadow-xs'
                        : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                    }`}
                  >
                    Answer Keys & Scoring Rubrics
                  </button>
                </>
              )}

              <button
                onClick={() => setShowExportModal(true)}
                className="px-3 py-1.5 rounded-xl text-xs font-bold cursor-pointer transition-all bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs flex items-center gap-1.5"
              >
                <Download className="w-3.5 h-3.5" />
                Export Exam (DOCX / PDF)
              </button>
            </div>
          </div>

          {/* Conditional View: Academic Paper Preview vs Interactive Editor */}
          {workspaceView === 'preview' ? (
            <AcademicPaperPreview
              exam={activeExam}
              activeGroupIndex={activeGroupIndex}
              onGroupSelect={setActiveGroupIndex}
              onClose={() => setWorkspaceView('editor')}
              onExport={(format, target, exportAll) => {
                setExportTarget(target);
                setExportScope(exportAll ? 'all' : 'current');
                const currentGroupId = exportAll ? '' : activeExam.groups[activeGroupIndex]?.id || '';
                let url = `/api/exams/${activeExam.id}/export/${format}?target=${target}&include_references=true`;
                if (currentGroupId) {
                  url += `&group_id=${currentGroupId}`;
                }
                window.location.href = url;
              }}
            />
          ) : (
            <>
              {/* Group Tabs (Group A, Group B, Group C) */}
              <div className="flex items-center gap-2 border-b border-stone-200 pb-2">
            {activeExam.groups.map((g, idx) => {
              const isSelected = activeGroupIndex === idx;
              return (
                <button
                  key={g.id}
                  onClick={() => setActiveGroupIndex(idx)}
                  className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 ${
                    isSelected
                      ? 'bg-stone-900 text-white shadow-xs'
                      : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                  }`}
                >
                  <Shuffle className="w-3 h-3 text-pink-400" />
                  {g.group_name}
                  <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-white/20">
                    {g.questions.length} Qs
                  </span>
                </button>
              );
            })}
          </div>

          {/* QUESTIONS VIEW */}
          {viewMode === 'questions' && currentGroup && (
            <div className="space-y-4">
              <div className="flex items-center justify-between text-xs text-stone-500 px-1">
                <span>
                  Viewing <strong className="text-stone-800">{currentGroup.group_name}</strong> (Permuted anti-cheating variant with synchronized answer keys)
                </span>
                <span>Total Marks: {currentGroup.questions.reduce((a, b) => a + b.marks, 0)} pts</span>
              </div>

              {currentGroup.questions.map((q) => {
                const isEditing = editingQuestionId === q.id;

                return (
                  <div
                    key={q.id}
                    className="p-5 bg-white rounded-2xl border border-stone-200 shadow-xs space-y-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className="w-6 h-6 rounded-lg bg-pink-50 text-[#9D174D] font-bold text-xs flex items-center justify-center">
                          {q.question_order}
                        </span>
                        <span className="text-xs uppercase font-mono px-2 py-0.5 rounded bg-stone-100 text-stone-600 border border-stone-200">
                          {q.question_type}
                        </span>
                        <span className="text-xs capitalize font-medium px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                          {q.difficulty}
                        </span>
                        {q.bloom_level && (
                          <span className="text-xs capitalize font-medium px-2 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200">
                            Bloom: {q.bloom_level}
                          </span>
                        )}
                        <span className="text-xs font-semibold text-stone-500">
                          Marks: {q.marks}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5">
                        {!isEditing ? (
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleStartEdit(q)}
                              className="px-2.5 py-1 text-xs font-semibold text-stone-700 bg-stone-100 hover:bg-stone-200 border border-stone-200 rounded-lg transition-all cursor-pointer flex items-center gap-1.5 shadow-2xs"
                              title="Edit Question, Choices, Answer & Rubric"
                            >
                              <Edit2 className="w-3.5 h-3.5 text-stone-600" />
                              <span>Edit</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setDeletingQuestion(q);
                                setDeleteError(null);
                              }}
                              className="px-2.5 py-1 text-xs font-bold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition-all cursor-pointer flex items-center gap-1.5 shadow-2xs"
                              title="Delete Question across all groups"
                            >
                              <Trash2 className="w-3.5 h-3.5 text-rose-600" />
                              <span>Delete Question</span>
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleSaveEdit(q.id)}
                              disabled={isSavingEdit}
                              className="px-3 py-1 bg-emerald-600 text-white text-xs font-semibold rounded-lg flex items-center gap-1 hover:bg-emerald-700 transition-all cursor-pointer shadow-2xs disabled:opacity-50"
                            >
                              <Save className="w-3 h-3" />
                              <span>{isSavingEdit ? 'Saving...' : 'Save'}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingQuestionId(null);
                                setEditError(null);
                              }}
                              className="p-1 text-stone-400 hover:text-stone-600 rounded-lg cursor-pointer"
                              title="Cancel"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Question Content & Full Edit Mode */}
                    {isEditing ? (
                      <div className="space-y-3 pt-1 border-t border-stone-100">
                        {editError && (
                          <div className="p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
                            <AlertTriangle className="w-4 h-4 shrink-0" />
                            <span>{editError}</span>
                          </div>
                        )}

                        <div>
                          <label className="text-xs font-bold text-stone-700 block mb-1">
                            Question Stem / Text:
                          </label>
                          <textarea
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            className="w-full p-2.5 border border-stone-300 rounded-xl text-xs focus:ring-2 focus:ring-[#9D174D]/30 focus:border-[#9D174D] outline-none"
                            rows={3}
                            placeholder="Enter question text..."
                          />
                        </div>

                        <div className="flex items-center gap-2">
                          <label className="text-xs font-semibold text-stone-700">Marks (Points):</label>
                          <input
                            type="number"
                            step="0.5"
                            min="0.5"
                            value={editMarks}
                            onChange={(e) => setEditMarks(parseFloat(e.target.value) || 1)}
                            className="w-24 px-2.5 py-1 border border-stone-300 rounded-lg text-xs"
                          />
                        </div>

                        {/* MCQ Options Editing (Supports all 4-5 options, correct answer selection, and reordering) */}
                        {editOptions && editOptions.length > 0 && (
                          <div className="space-y-2 pt-2 border-t border-stone-100">
                            <div className="flex items-center justify-between">
                              <label className="text-xs font-bold text-stone-700">
                                Answer Choices ({editOptions.length} Options):
                              </label>
                              <span className="text-[11px] text-stone-500">
                                Select radio button next to choice to set as correct answer. Use arrows to reorder.
                              </span>
                            </div>

                            <div className="space-y-2">
                              {editOptions.map((opt, i) => {
                                const letters = ['A', 'B', 'C', 'D', 'E'];
                                const label = letters[i] || `${i + 1}`;
                                const isChecked = editCorrectAnswer === opt;

                                return (
                                  <div
                                    key={i}
                                    className={`p-2.5 rounded-xl border flex items-center gap-2 transition-all ${
                                      isChecked
                                        ? 'border-emerald-400 bg-emerald-50/70 shadow-2xs'
                                        : 'border-stone-200 bg-stone-50/50'
                                    }`}
                                  >
                                    <label
                                      className="flex items-center gap-1.5 cursor-pointer shrink-0"
                                      title="Mark as correct answer"
                                    >
                                      <input
                                        type="radio"
                                        name={`correct_choice_${q.id}`}
                                        checked={isChecked}
                                        onChange={() => setEditCorrectAnswer(opt)}
                                        className="accent-emerald-600 cursor-pointer w-4 h-4"
                                      />
                                      <span
                                        className={`w-6 h-6 rounded-md text-[11px] font-bold flex items-center justify-center shrink-0 border ${
                                          isChecked
                                            ? 'bg-emerald-600 text-white border-emerald-600'
                                            : 'bg-white text-stone-700 border-stone-200'
                                        }`}
                                      >
                                        {label}
                                      </span>
                                    </label>

                                    <input
                                      type="text"
                                      value={opt}
                                      onChange={(e) => {
                                        const newOpts = [...editOptions];
                                        const oldVal = newOpts[i];
                                        const newVal = e.target.value;
                                        newOpts[i] = newVal;
                                        setEditOptions(newOpts);
                                        // If this was the correct answer, keep correct answer in sync
                                        if (isChecked || editCorrectAnswer === oldVal) {
                                          setEditCorrectAnswer(newVal);
                                        }
                                      }}
                                      className="flex-1 px-3 py-1.5 border border-stone-300 rounded-lg text-xs bg-white focus:ring-1 focus:ring-emerald-500 outline-none"
                                      placeholder={`Option ${label}`}
                                    />

                                    {/* Reorder Up and Down buttons */}
                                    <div className="flex items-center gap-0.5 shrink-0">
                                      <button
                                        type="button"
                                        disabled={i === 0}
                                        onClick={() => {
                                          if (i === 0) return;
                                          const newOpts = [...editOptions];
                                          const temp = newOpts[i];
                                          newOpts[i] = newOpts[i - 1];
                                          newOpts[i - 1] = temp;
                                          setEditOptions(newOpts);
                                        }}
                                        className={`p-1 rounded cursor-pointer ${
                                          i === 0
                                            ? 'text-stone-300 cursor-not-allowed'
                                            : 'text-stone-500 hover:text-stone-800 hover:bg-stone-200/70'
                                        }`}
                                        title="Move choice up"
                                      >
                                        <ChevronUp className="w-3.5 h-3.5" />
                                      </button>
                                      <button
                                        type="button"
                                        disabled={i === editOptions.length - 1}
                                        onClick={() => {
                                          if (i === editOptions.length - 1) return;
                                          const newOpts = [...editOptions];
                                          const temp = newOpts[i];
                                          newOpts[i] = newOpts[i + 1];
                                          newOpts[i + 1] = temp;
                                          setEditOptions(newOpts);
                                        }}
                                        className={`p-1 rounded cursor-pointer ${
                                          i === editOptions.length - 1
                                            ? 'text-stone-300 cursor-not-allowed'
                                            : 'text-stone-500 hover:text-stone-800 hover:bg-stone-200/70'
                                        }`}
                                        title="Move choice down"
                                      >
                                        <ChevronDown className="w-3.5 h-3.5" />
                                      </button>
                                    </div>

                                    {editOptions.length > 2 && (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          const newOpts = editOptions.filter((_, idx) => idx !== i);
                                          setEditOptions(newOpts);
                                          if (isChecked && newOpts.length > 0) {
                                            setEditCorrectAnswer(newOpts[0]);
                                          }
                                        }}
                                        className="p-1 text-stone-400 hover:text-rose-600 rounded cursor-pointer shrink-0"
                                        title="Remove option"
                                      >
                                        <X className="w-3.5 h-3.5" />
                                      </button>
                                    )}
                                  </div>
                                );
                              })}
                            </div>

                            {editOptions.length < 5 && (
                              <button
                                type="button"
                                onClick={() => {
                                  const letters = ['A', 'B', 'C', 'D', 'E'];
                                  const nextLabel = letters[editOptions.length] || `${editOptions.length + 1}`;
                                  setEditOptions([...editOptions, `New Option ${nextLabel}`]);
                                }}
                                className="text-xs font-semibold text-[#9D174D] hover:underline cursor-pointer pt-1 inline-block"
                              >
                                + Add Choice Option
                              </button>
                            )}
                          </div>
                        )}

                        {/* Non-MCQ Correct Answer Input */}
                        {(!editOptions || editOptions.length === 0) && (
                          <div className="space-y-1 pt-2 border-t border-stone-100">
                            <label className="text-xs font-bold text-stone-700 block">
                              Correct Answer:
                            </label>
                            <input
                              type="text"
                              value={editCorrectAnswer}
                              onChange={(e) => setEditCorrectAnswer(e.target.value)}
                              className="w-full px-2.5 py-1.5 border border-stone-300 rounded-lg text-xs focus:ring-1 focus:ring-emerald-500 outline-none"
                              placeholder="Enter official correct answer..."
                            />
                          </div>
                        )}

                        {/* Pedagogical Explanation / Scoring Rubric */}
                        <div className="space-y-1 pt-2 border-t border-stone-100">
                          <label className="text-xs font-bold text-stone-700 block">
                            Scoring Rubric & Pedagogical Explanation:
                          </label>
                          <textarea
                            value={editExplanation}
                            onChange={(e) => setEditExplanation(e.target.value)}
                            className="w-full p-2.5 border border-stone-300 rounded-xl text-xs focus:ring-2 focus:ring-[#9D174D]/30 focus:border-[#9D174D] outline-none"
                            rows={2}
                            placeholder="Enter rationale, rubric criteria, or textbook context..."
                          />
                        </div>
                      </div>
                    ) : (
                      <p
                        className={`text-xs font-medium text-stone-900 leading-relaxed ${
                          activeExam.is_rtl ? 'text-right' : 'text-left'
                        }`}
                        dir={activeExam.is_rtl ? 'rtl' : 'ltr'}
                      >
                        {q.question_text}
                      </p>
                    )}

                    {/* Multiple Choice Options Display (in view mode) */}
                    {!isEditing && q.options && q.options.length > 0 && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-1">
                        {q.options.map((opt, i) => {
                          const letters = ['A', 'B', 'C', 'D', 'E'];
                          const isCorrect = q.correct_answer.includes(opt) || q.correct_answer.startsWith(letters[i]);
                          return (
                            <div
                              key={i}
                              className={`p-2.5 rounded-xl border text-xs flex items-center gap-2 ${
                                isCorrect
                                  ? 'border-emerald-300 bg-emerald-50/60 font-semibold text-emerald-900'
                                  : 'border-stone-200 bg-stone-50/40 text-stone-700'
                              }`}
                            >
                              <span className="w-5 h-5 rounded-md bg-white border border-stone-200 text-stone-500 text-[10px] font-bold flex items-center justify-center shrink-0">
                                {letters[i]}
                              </span>
                              <span>{opt}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Correct Answer & Pedagogical Explanation Display (in view mode) */}
                    {!isEditing && (
                      <div className="p-3 bg-stone-50 rounded-xl border border-stone-200/60 text-xs space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-emerald-800">Correct Answer:</span>
                          <span className="text-stone-800 font-medium">{q.correct_answer}</span>
                        </div>
                        {q.explanation && (
                          <p className="text-[11px] text-stone-500 leading-relaxed">
                            <strong className="text-stone-600">Rationale / Rubric:</strong> {q.explanation}
                          </p>
                        )}
                      </div>
                    )}

                    {/* Strict Source Grounding Citation */}
                    <div className="pt-2 border-t border-stone-100 flex flex-wrap items-center gap-2 text-[11px] text-stone-500">
                      <span className="font-semibold text-stone-700 flex items-center gap-1">
                        <BookOpen className="w-3 h-3 text-[#9D174D]" />
                        Source Provenance:
                      </span>
                      <span className="bg-stone-100 px-2 py-0.5 rounded font-mono text-[10px]">
                        {q.source_document_name}
                      </span>
                      <span>Page {q.source_page}</span>
                      {q.source_chapter && <span>• {q.source_chapter}</span>}
                      {q.source_evidence && (
                        <span className="italic text-stone-400 block w-full mt-1">
                          "{q.source_evidence}"
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ANSWER KEYS VIEW */}
          {viewMode === 'answer_keys' && (
            <div className="space-y-4">
              <h4 className="text-xs font-bold text-stone-800 uppercase tracking-wider">
                Official Answer Keys & Scoring Rubrics for All Groups
              </h4>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {answerKeys.map((keyGroup) => (
                  <div
                    key={keyGroup.id}
                    className="p-5 bg-white rounded-2xl border border-stone-200 shadow-xs space-y-3"
                  >
                    <div className="flex items-center justify-between border-b border-stone-100 pb-2">
                      <h5 className="font-bold text-xs text-[#9D174D] flex items-center gap-1">
                        <Award className="w-3.5 h-3.5" />
                        {keyGroup.group_name} Answer Key
                      </h5>
                      <span className="text-[10px] text-stone-400">
                        {keyGroup.items.length} Questions
                      </span>
                    </div>

                    <div className="space-y-2">
                      {keyGroup.items.map((item) => (
                        <div
                          key={item.question_number}
                          className="p-2.5 rounded-lg border border-stone-100 bg-stone-50/50 text-xs space-y-1"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-stone-900">
                              Q{item.question_number} ({item.question_type})
                            </span>
                            <span className="text-emerald-700 font-bold">
                              {item.marks} pts
                            </span>
                          </div>
                          <div className="text-emerald-800 font-semibold">
                            Answer: {item.correct_answer}
                          </div>
                          {item.explanation && (
                            <p className="text-[10px] text-stone-500">{item.explanation}</p>
                          )}
                          <div className="text-[10px] text-stone-400">
                            Ref: {item.source_reference} (P. {item.source_page})
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )}

      {/* Export Engine Modal */}
      {showExportModal && activeExam && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
          <div className="bg-white rounded-2xl border border-stone-200 shadow-2xl max-w-lg w-full p-6 space-y-5 animate-in fade-in duration-150">
            <div className="flex items-center justify-between border-b border-stone-100 pb-3">
              <div className="flex items-center gap-2">
                <FileDown className="w-5 h-5 text-emerald-600" />
                <h3 className="text-base font-bold text-stone-900">Export Examination Package</h3>
              </div>
              <button
                onClick={() => setShowExportModal(false)}
                className="p-1 rounded-lg hover:bg-stone-100 text-stone-400 hover:text-stone-600"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4 text-xs">
              {/* Target Scope */}
              <div className="space-y-1.5">
                <label className="font-bold text-stone-700 block">Groups Selection</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setExportScope('current')}
                    className={`p-2.5 rounded-xl border text-left cursor-pointer transition-all ${
                      exportScope === 'current'
                        ? 'border-emerald-600 bg-emerald-50/50 text-emerald-900 font-bold'
                        : 'border-stone-200 hover:bg-stone-50 text-stone-600'
                    }`}
                  >
                    <div>Current Group ({activeExam.groups[activeGroupIndex]?.group_name})</div>
                    <div className="text-[10px] text-stone-400 font-normal">Only selected exam variant</div>
                  </button>
                  <button
                    onClick={() => setExportScope('all')}
                    className={`p-2.5 rounded-xl border text-left cursor-pointer transition-all ${
                      exportScope === 'all'
                        ? 'border-emerald-600 bg-emerald-50/50 text-emerald-900 font-bold'
                        : 'border-stone-200 hover:bg-stone-50 text-stone-600'
                    }`}
                  >
                    <div>All Groups (Compiled Master)</div>
                    <div className="text-[10px] text-stone-400 font-normal">All {activeExam.groups_count} groups separated by page breaks</div>
                  </button>
                </div>
              </div>

              {/* Document Components */}
              <div className="space-y-1.5">
                <label className="font-bold text-stone-700 block">Document Components</label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={() => setExportTarget('both')}
                    className={`p-2 rounded-xl border text-center cursor-pointer transition-all ${
                      exportTarget === 'both'
                        ? 'border-emerald-600 bg-emerald-50/50 text-emerald-900 font-bold'
                        : 'border-stone-200 hover:bg-stone-50 text-stone-600'
                    }`}
                  >
                    Paper + Answer Key
                  </button>
                  <button
                    onClick={() => setExportTarget('exam')}
                    className={`p-2 rounded-xl border text-center cursor-pointer transition-all ${
                      exportTarget === 'exam'
                        ? 'border-emerald-600 bg-emerald-50/50 text-emerald-900 font-bold'
                        : 'border-stone-200 hover:bg-stone-50 text-stone-600'
                    }`}
                  >
                    Student Paper Only
                  </button>
                  <button
                    onClick={() => setExportTarget('answer_key')}
                    className={`p-2 rounded-xl border text-center cursor-pointer transition-all ${
                      exportTarget === 'answer_key'
                        ? 'border-emerald-600 bg-emerald-50/50 text-emerald-900 font-bold'
                        : 'border-stone-200 hover:bg-stone-50 text-stone-600'
                    }`}
                  >
                    Answer Key Only
                  </button>
                </div>
              </div>

              {/* Provenance flag */}
              <div className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  id="includeProv"
                  checked={includeProvenance}
                  onChange={(e) => setIncludeProvenance(e.target.checked)}
                  className="rounded border-stone-300 text-emerald-600 focus:ring-emerald-500"
                />
                <label htmlFor="includeProv" className="text-stone-700 cursor-pointer">
                  Include source evidence citations & page references in Answer Key
                </label>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center justify-end gap-3 pt-3 border-t border-stone-100">
              <button
                onClick={() => setShowExportModal(false)}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-stone-600 hover:bg-stone-100 cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => handleExport('docx')}
                className="px-4 py-2 rounded-xl text-xs font-bold bg-blue-600 hover:bg-blue-700 text-white shadow-xs cursor-pointer flex items-center gap-1.5"
              >
                <FileText className="w-3.5 h-3.5" />
                Download DOCX (.docx)
              </button>
              <button
                onClick={() => handleExport('pdf')}
                className="px-4 py-2 rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs cursor-pointer flex items-center gap-1.5"
              >
                <Download className="w-3.5 h-3.5" />
                Download PDF (.pdf)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Question Confirmation Dialog */}
      {deletingQuestion && activeExam && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4 no-print">
          <div className="bg-white rounded-2xl border border-stone-200 shadow-2xl max-w-md w-full p-6 space-y-4 animate-in fade-in duration-150">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-rose-100 text-rose-600 flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5" />
              </div>
              <div className="space-y-1 flex-1">
                <h3 className="text-sm font-bold text-stone-900">
                  Delete Question {deletingQuestion.question_order}?
                </h3>
                <p className="text-xs text-stone-500 leading-relaxed">
                  Are you sure you want to delete this question? This action will synchronize deletion of this question and its isomorphic variants across all {activeExam.groups.length} examination groups, automatically update sequential numbering, recalculate total marks, and maintain consistent answer keys.
                </p>
              </div>
            </div>

            {/* Question preview snippet */}
            <div className="p-3 bg-stone-50 rounded-xl border border-stone-200/80 text-xs space-y-1">
              <span className="text-[10px] uppercase font-bold text-stone-400">Question Content:</span>
              <p className="text-stone-800 line-clamp-3 font-medium">"{deletingQuestion.question_text}"</p>
              <div className="flex items-center gap-2 pt-1 text-[11px] text-stone-500">
                <span>Marks: {deletingQuestion.marks} pt</span>
                <span>•</span>
                <span>Type: {deletingQuestion.question_type.toUpperCase()}</span>
              </div>
            </div>

            {deleteError && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{deleteError}</span>
              </div>
            )}

            {/* Dialog Actions */}
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-stone-100">
              <button
                type="button"
                onClick={() => {
                  setDeletingQuestion(null);
                  setDeleteError(null);
                }}
                disabled={isDeletingQuestion}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-stone-600 hover:bg-stone-100 cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteQuestion}
                disabled={isDeletingQuestion}
                className="px-4 py-2 rounded-xl text-xs font-bold bg-rose-600 hover:bg-rose-700 text-white shadow-xs cursor-pointer flex items-center gap-1.5 transition-all disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{isDeletingQuestion ? 'Deleting...' : 'Confirm Delete'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
