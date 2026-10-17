import React, { useState, useEffect } from 'react';
import {
  X,
  Mail,
  Lock,
  User,
  GraduationCap,
  ArrowRight,
  ShieldCheck,
  AlertCircle,
  CheckCircle2,
  Sparkles,
} from 'lucide-react';
import {
  TeacherUser,
  setAuthToken,
  setSavedUser,
  getGuestSessionId,
} from '../utils/auth';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (user: TeacherUser) => void;
}

export function AuthModal({ isOpen, onClose, onSuccess }: AuthModalProps) {
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [institution, setInstitution] = useState('');
  // Explicit consent checkbox MUST be unchecked by default
  const [consentImportGuest, setConsentImportGuest] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const clearFormState = () => {
    setEmail('');
    setPassword('');
    setFullName('');
    setInstitution('');
    setConsentImportGuest(false);
    setErrorMsg(null);
    setSuccessMsg(null);
  };

  // Reset sensitive fields on modal open/close
  useEffect(() => {
    if (isOpen) {
      setPassword('');
      setErrorMsg(null);
      setSuccessMsg(null);
      setConsentImportGuest(false);
    } else {
      setPassword('');
    }
  }, [isOpen]);

  // Cleanly wipe all form details on logout or token expiration
  useEffect(() => {
    const handleAuthReset = () => {
      clearFormState();
      setTab('login');
    };
    window.addEventListener('examcraft_auth_changed', handleAuthReset);
    window.addEventListener('examcraft_auth_expired', handleAuthReset);
    return () => {
      window.removeEventListener('examcraft_auth_changed', handleAuthReset);
      window.removeEventListener('examcraft_auth_expired', handleAuthReset);
    };
  }, []);

  const handleTabSwitch = (newTab: 'login' | 'register') => {
    if (newTab === tab) return;
    setTab(newTab);
    // Clear password whenever switching between Sign In and Create Account
    setPassword('');
    setErrorMsg(null);
    setSuccessMsg(null);
    setConsentImportGuest(false);
    if (newTab === 'login') {
      setFullName('');
      setInstitution('');
    }
  };

  const handleClose = () => {
    setPassword('');
    setErrorMsg(null);
    setSuccessMsg(null);
    onClose();
  };

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);
    setIsLoading(true);

    try {
      if (tab === 'login') {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.detail || 'Login failed. Please check your credentials.');
        }

        setAuthToken(data.token);
        setSavedUser(data.user);
        setPassword('');
        setSuccessMsg('Welcome back! Loading your saved examinations...');
        setTimeout(() => {
          onSuccess(data.user);
          clearFormState();
          onClose();
        }, 600);
      } else {
        const guestId = getGuestSessionId();
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            password,
            full_name: fullName,
            institution,
            import_guest_session_id: guestId,
            consent_import_guest: consentImportGuest,
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.detail || 'Registration failed. Please check your details.');
        }

        setAuthToken(data.token);
        setSavedUser(data.user);
        setPassword('');
        setSuccessMsg(
          consentImportGuest && data.guest_migration?.transferredExams > 0
            ? 'Account created and guest examination successfully linked!'
            : 'Teacher account created successfully!'
        );
        setTimeout(() => {
          onSuccess(data.user);
          clearFormState();
          onClose();
        }, 800);
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'An unexpected error occurred.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div
        className="w-full max-w-md bg-white rounded-3xl shadow-2xl border border-stone-200 overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="bg-gradient-to-br from-[#9D174D] to-[#83133E] text-white p-6 relative">
          <button
            onClick={handleClose}
            className="absolute top-5 right-5 w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>

          <div className="flex items-center gap-3 mb-2">
            <div className="w-9 h-9 rounded-xl bg-white/15 flex items-center justify-center font-black text-lg">
              E
            </div>
            <div>
              <h2 className="text-lg font-bold">ExamCraft Educator Portal</h2>
              <p className="text-xs text-pink-100 font-medium">
                Persistent examination storage & multi-group management
              </p>
            </div>
          </div>

          {/* Tab Switcher */}
          <div className="flex bg-black/20 p-1 rounded-xl mt-4">
            <button
              type="button"
              onClick={() => handleTabSwitch('login')}
              className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                tab === 'login'
                  ? 'bg-white text-[#9D174D] shadow-xs'
                  : 'text-white/80 hover:text-white'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => handleTabSwitch('register')}
              className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                tab === 'register'
                  ? 'bg-white text-[#9D174D] shadow-xs'
                  : 'text-white/80 hover:text-white'
              }`}
            >
              Create Account
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {errorMsg && (
            <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {successMsg && (
            <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-start gap-2.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
              <span>{successMsg}</span>
            </div>
          )}

          {tab === 'register' && (
            <>
              <div>
                <label className="block text-xs font-bold text-stone-700 mb-1">
                  Full Name & Title
                </label>
                <div className="relative">
                  <User className="w-4 h-4 text-stone-400 absolute left-3 top-3" />
                  <input
                    type="text"
                    required
                    placeholder="Prof. Jane Harrison"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    className="w-full pl-9 pr-3 py-2 text-xs rounded-xl border border-stone-200 focus:outline-hidden focus:ring-2 focus:ring-[#9D174D]/30 focus:border-[#9D174D]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-stone-700 mb-1">
                  Academic Institution / Department
                </label>
                <div className="relative">
                  <GraduationCap className="w-4 h-4 text-stone-400 absolute left-3 top-3" />
                  <input
                    type="text"
                    placeholder="Department of Biological Sciences"
                    value={institution}
                    onChange={(e) => setInstitution(e.target.value)}
                    className="w-full pl-9 pr-3 py-2 text-xs rounded-xl border border-stone-200 focus:outline-hidden focus:ring-2 focus:ring-[#9D174D]/30 focus:border-[#9D174D]"
                  />
                </div>
              </div>
            </>
          )}

          <div>
            <label className="block text-xs font-bold text-stone-700 mb-1">
              Email Address
            </label>
            <div className="relative">
              <Mail className="w-4 h-4 text-stone-400 absolute left-3 top-3" />
              <input
                type="email"
                required
                placeholder="instructor@university.edu"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-xs rounded-xl border border-stone-200 focus:outline-hidden focus:ring-2 focus:ring-[#9D174D]/30 focus:border-[#9D174D]"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-stone-700 mb-1">
              Password
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-stone-400 absolute left-3 top-3" />
              <input
                type="password"
                required
                minLength={6}
                placeholder="At least 6 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-xs rounded-xl border border-stone-200 focus:outline-hidden focus:ring-2 focus:ring-[#9D174D]/30 focus:border-[#9D174D]"
              />
            </div>
          </div>

          {/* Explicit Consent Checkbox for Guest Data Migration */}
          {tab === 'register' && (
            <div className="p-3.5 rounded-xl bg-pink-50/70 border border-pink-200/90 space-y-1.5">
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={consentImportGuest}
                  onChange={(e) => setConsentImportGuest(e.target.checked)}
                  className="mt-0.5 rounded text-[#9D174D] focus:ring-[#9D174D]"
                />
                <span className="text-xs font-bold text-stone-800 leading-tight">
                  Import my current guest examination & documents into my new account
                </span>
              </label>
              <p className="text-[11px] text-stone-500 pl-6 leading-relaxed">
                If checked, your active guest session exam and documents will be permanently assigned to your teacher account. If unchecked, your account will start fresh.
              </p>
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-2.5 px-4 bg-[#9D174D] hover:bg-[#83133E] text-white text-xs font-bold rounded-xl transition-all shadow-xs flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
          >
            {isLoading ? (
              <span className="inline-block animate-spin mr-1">⏳</span>
            ) : (
              <ArrowRight className="w-4 h-4" />
            )}
            <span>
              {tab === 'login' ? 'Sign In to Account' : 'Create Teacher Account'}
            </span>
          </button>

          <div className="pt-2 border-t border-stone-100 flex items-center justify-between text-[11px] text-stone-500">
            <span>Prefer testing without an account?</span>
            <button
              type="button"
              onClick={handleClose}
              className="font-semibold text-[#9D174D] hover:underline cursor-pointer"
            >
              Continue in Guest Mode
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
