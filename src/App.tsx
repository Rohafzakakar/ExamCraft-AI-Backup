import React, { useState, useEffect } from 'react';
import {
  Key,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  FileText,
  BookOpen,
  Cpu,
  Layers,
  Database,
  ArrowRight,
  User,
  LogOut,
  Sparkles,
} from 'lucide-react';
import { SecureLLMSettingsModal } from './components/SecureLLMSettingsModal';
import { ExamWorkspace } from './components/ExamWorkspace';
import { AuthModal } from './components/AuthModal';
import { ExamHistoryModal, SavedExamSummary } from './components/ExamHistoryModal';
import {
  TeacherUser,
  getSavedUser,
  removeAuthToken,
  removeSavedUser,
  resetGuestSessionId,
  authFetch,
} from './utils/auth';

export default function App() {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isLlmConfigured, setIsLlmConfigured] = useState(false);
  const [activeModel, setActiveModel] = useState('openrouter/free');

  // Authentication & History States
  const [currentUser, setCurrentUser] = useState<TeacherUser | null>(getSavedUser());
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
  const [savedExams, setSavedExams] = useState<SavedExamSummary[]>([]);
  const [activeExamId, setActiveExamId] = useState<string | null>(null);

  // Check LLM status on mount
  const checkStatus = async () => {
    try {
      const res = await fetch('/api/llm/status');
      if (res.ok) {
        const data = await res.json();
        setIsLlmConfigured(data.is_configured);
        if (data.model) setActiveModel(data.model);
      }
    } catch {
      // Backend may be booting
    }
  };

  // Fetch initial exams list for history modal count
  const fetchExamsList = async () => {
    try {
      const res = await authFetch('/api/exams');
      if (res.ok) {
        const data = await res.json();
        setSavedExams(data);
      }
    } catch {
      // Backend booting
    }
  };

  useEffect(() => {
    checkStatus();
    fetchExamsList();

    const handleAuthExpired = () => {
      setCurrentUser(null);
      fetchExamsList();
    };

    window.addEventListener('examcraft_auth_expired', handleAuthExpired);
    return () => {
      window.removeEventListener('examcraft_auth_expired', handleAuthExpired);
    };
  }, []);

  const handleLogout = async () => {
    try {
      await authFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // proceed with local cleanup
    }
    removeAuthToken();
    removeSavedUser();
    resetGuestSessionId();
    setCurrentUser(null);
    setIsAuthModalOpen(false);
    window.dispatchEvent(new CustomEvent('examcraft_auth_changed'));
    fetchExamsList();
  };

  const handleAuthSuccess = (user: TeacherUser) => {
    setCurrentUser(user);
    window.dispatchEvent(new CustomEvent('examcraft_auth_changed'));
    fetchExamsList();
  };

  const handleSelectExamFromHistory = (examId: string) => {
    setActiveExamId(examId);
  };

  const handleCreateNewExam = () => {
    setActiveExamId(null);
  };

  const handleDeleteExamFromHistory = (examId: string) => {
    setSavedExams((prev) => prev.filter((e) => e.id !== examId));
    window.dispatchEvent(new CustomEvent('examcraft_auth_changed'));
  };

  return (
    <div className="min-h-screen bg-[#FAF9F6] text-[#1F1924] flex flex-col">
      {/* Top Navigation Bar */}
      <header className="no-print border-b border-[#F3E8EC] bg-white/90 backdrop-blur sticky top-0 z-30 px-6 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-[#9D174D] text-white flex items-center justify-center font-black text-lg shadow-sm">
            E
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-lg tracking-tight text-[#9D174D]">ExamCraft AI</span>
              <span className="text-[10px] uppercase font-bold tracking-widest px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                Phase 1 Verified
              </span>
            </div>
            <p className="text-xs text-stone-500 font-medium">
              Source-Grounded Examination Platform for Educators
            </p>
          </div>
        </div>

        {/* Header Actions */}
        <div className="flex items-center gap-3">
          {/* Exam History Button */}
          <button
            onClick={() => setIsHistoryModalOpen(true)}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border border-pink-200 bg-pink-50/80 hover:bg-pink-100 text-[#9D174D] text-xs font-bold transition-all shadow-2xs cursor-pointer"
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>Exam History</span>
            <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-[#9D174D] text-white font-bold">
              {savedExams.length}
            </span>
          </button>

          {/* Secure LLM Settings Button */}
          <button
            onClick={() => setIsSettingsOpen(true)}
            className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-xl border text-xs font-semibold transition-all shadow-xs cursor-pointer ${
              isLlmConfigured
                ? 'bg-emerald-50 border-emerald-300 text-emerald-900 hover:bg-emerald-100/80'
                : 'bg-amber-50 border-amber-300 text-amber-900 hover:bg-amber-100/80 ring-2 ring-amber-400/30'
            }`}
          >
            <span className="relative flex h-2 w-2">
              {isLlmConfigured ? (
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              ) : (
                <>
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
                </>
              )}
            </span>
            <Key className="w-3.5 h-3.5" />
            <span>
              {isLlmConfigured ? 'OpenRouter: Configured' : 'Configure OpenRouter Key'}
            </span>
          </button>

          {/* Teacher Auth / Guest Status Indicator */}
          {currentUser ? (
            <div className="flex items-center gap-2 pl-2 border-l border-stone-200">
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-stone-100 border border-stone-200/80 text-stone-800 text-xs font-semibold">
                <div className="w-5 h-5 rounded-full bg-[#9D174D] text-white flex items-center justify-center font-bold text-[10px]">
                  {currentUser.full_name.charAt(0).toUpperCase()}
                </div>
                <div className="text-left hidden sm:block">
                  <div className="leading-tight font-bold">{currentUser.full_name}</div>
                  <div className="text-[10px] text-stone-500 font-normal truncate max-w-[120px]">
                    {currentUser.institution || 'Teacher'}
                  </div>
                </div>
              </div>
              <button
                onClick={handleLogout}
                title="Log Out"
                className="p-1.5 rounded-xl border border-stone-200 hover:bg-rose-50 text-stone-500 hover:text-rose-600 transition-colors cursor-pointer"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 pl-2 border-l border-stone-200">
              <div className="px-2.5 py-1 rounded-xl bg-stone-100 text-stone-600 text-xs font-medium hidden sm:flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-stone-400" />
                <span>Guest Mode</span>
              </div>
              <button
                onClick={() => setIsAuthModalOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#9D174D] hover:bg-[#83133E] text-white text-xs font-bold transition-all shadow-xs cursor-pointer"
              >
                <User className="w-3.5 h-3.5" />
                <span>Sign In / Register</span>
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Main Dashboard Container */}
      <main className="max-w-6xl mx-auto p-6 md:p-8 flex-1 w-full space-y-8">
        {/* LLM Credential Banner Card */}
        <div
          className={`no-print p-6 rounded-2xl border transition-all ${
            isLlmConfigured
              ? 'bg-emerald-50/60 border-emerald-200/90'
              : 'bg-gradient-to-r from-amber-50/90 to-pink-50/70 border-amber-200/90'
          }`}
        >
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-start gap-4">
              <div
                className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 shadow-xs ${
                  isLlmConfigured
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-[#9D174D] text-white'
                }`}
              >
                {isLlmConfigured ? (
                  <CheckCircle2 className="w-6 h-6" />
                ) : (
                  <ShieldCheck className="w-6 h-6" />
                )}
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-bold text-stone-900">
                    {isLlmConfigured
                      ? 'OpenRouter LLM Ready in Server Memory'
                      : 'OpenRouter Credential Required'}
                  </h2>
                  <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-white/90 border border-stone-200 text-stone-700">
                    Model: {activeModel}
                  </span>
                </div>
                <p className="text-xs text-stone-600 max-w-2xl leading-relaxed">
                  {isLlmConfigured
                    ? 'Your API key is securely held in server RAM. It is never stored in browser storage, never written to disk or database, and never committed to source files.'
                    : 'To enable automated question generation, enter your OpenRouter key into the secure password-masked modal. Keys are transmitted over HTTPS directly to server memory only.'}
                </p>
              </div>
            </div>

            <button
              onClick={() => setIsSettingsOpen(true)}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-[#9D174D] hover:bg-[#83133E] text-white text-xs font-semibold rounded-xl transition-all shadow-xs cursor-pointer shrink-0"
            >
              <Key className="w-4 h-4" />
              <span>{isLlmConfigured ? 'Manage LLM Settings' : 'Enter API Key Securely'}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Active Educator Examination Workspace */}
        <ExamWorkspace
          isLlmConfigured={isLlmConfigured}
          externalActiveExamId={activeExamId}
          onOpenHistory={() => setIsHistoryModalOpen(true)}
          onExamsUpdated={(exams) => setSavedExams(exams as any)}
        />

        {/* Phase 1 Verification Overview & Persistence Architecture */}
        <div className="no-print space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-stone-900 tracking-tight flex items-center gap-2">
              <Layers className="w-4 h-4 text-[#9D174D]" />
              Phase 1 Authentication & Persistence Architecture
            </h3>
            <span className="text-xs text-emerald-700 font-semibold bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-200 flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              SQLite Persistent Database Active
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Database & Persistence */}
            <div className="p-5 bg-white rounded-2xl border border-stone-200/80 shadow-xs space-y-2">
              <div className="w-8 h-8 rounded-lg bg-pink-50 text-[#9D174D] flex items-center justify-center mb-1">
                <Database className="w-4 h-4" />
              </div>
              <h4 className="text-xs font-bold text-stone-900">Node 22 Built-in SQLite</h4>
              <p className="text-[11px] text-stone-500 leading-relaxed">
                Relational SQLite engine with WAL mode and automated rolling backups. Preserves all exams, documents, groups, and questions across server restarts.
              </p>
              <div className="pt-2">
                <span className="text-[10px] font-mono font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                  data/examcraft.db: WAL Mode
                </span>
              </div>
            </div>

            {/* Authentication & Guest Isolation */}
            <div className="p-5 bg-white rounded-2xl border border-stone-200/80 shadow-xs space-y-2">
              <div className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center mb-1">
                <ShieldCheck className="w-4 h-4" />
              </div>
              <h4 className="text-xs font-bold text-stone-900">Teacher Auth & Guest Isolation</h4>
              <p className="text-[11px] text-stone-500 leading-relaxed">
                scryptSync password hashing with 16-byte random salts. Isolated guest sessions with explicit consent opt-in when migrating to a registered account.
              </p>
              <div className="pt-2">
                <span className="text-[10px] font-mono font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                  HMAC-SHA256 Bearer: 7d TTL
                </span>
              </div>
            </div>

            {/* Multi-Group Archiving */}
            <div className="p-5 bg-white rounded-2xl border border-stone-200/80 shadow-xs space-y-2">
              <div className="w-8 h-8 rounded-lg bg-purple-50 text-purple-700 flex items-center justify-center mb-1">
                <BookOpen className="w-4 h-4" />
              </div>
              <h4 className="text-xs font-bold text-stone-900">Archive & History Drawer</h4>
              <p className="text-[11px] text-stone-500 leading-relaxed">
                Full examination history with instant workspace switching, question counts, marks, and direct Word (DOCX) and PDF export triggers.
              </p>
              <div className="pt-2">
                <span className="text-[10px] font-mono font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                  Archive UI: Operational
                </span>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Secure LLM Settings Modal */}
      <SecureLLMSettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onStatusChange={(configured) => setIsLlmConfigured(configured)}
      />

      {/* Teacher Authentication Modal */}
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
        onSuccess={handleAuthSuccess}
      />

      {/* Exam History Modal */}
      <ExamHistoryModal
        isOpen={isHistoryModalOpen}
        onClose={() => setIsHistoryModalOpen(false)}
        exams={savedExams}
        activeExamId={activeExamId}
        onSelectExam={handleSelectExamFromHistory}
        onCreateNewExam={handleCreateNewExam}
        onDeleteExam={handleDeleteExamFromHistory}
      />
    </div>
  );
}
