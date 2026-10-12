import React, { useState, useEffect } from 'react';
import {
  ShieldCheck,
  Key,
  Eye,
  EyeOff,
  CheckCircle2,
  AlertCircle,
  Trash2,
  RefreshCw,
  Cpu,
  X,
  Lock,
  Server,
  Zap,
} from 'lucide-react';

interface LLMStatus {
  provider: string;
  model: string;
  is_configured: boolean;
  masked_key: string | null;
  storage_source: string;
  status_label: string;
}

interface TestResult {
  success: boolean;
  message: string;
  latency_ms?: number;
  status_code?: number;
}

interface SecureLLMSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onStatusChange?: (isConfigured: boolean) => void;
}

export const SecureLLMSettingsModal: React.FC<SecureLLMSettingsModalProps> = ({
  isOpen,
  onClose,
  onStatusChange,
}) => {
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [status, setStatus] = useState<LLMStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [feedbackMessage, setFeedbackMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Fetch current masked status from server
  const fetchStatus = async () => {
    try {
      setIsLoading(true);
      const res = await fetch('/api/llm/status');
      if (res.ok) {
        const data: LLMStatus = await res.json();
        setStatus(data);
        if (onStatusChange) {
          onStatusChange(data.is_configured);
        }
      }
    } catch {
      // Ignore initial background fetch error
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchStatus();
      setFeedbackMessage(null);
      setTestResult(null);
      setApiKeyInput('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  // Save API key strictly to backend server memory
  const handleSaveKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKeyInput.trim() || apiKeyInput.trim().length < 10) {
      setFeedbackMessage({
        type: 'error',
        text: 'Please enter a valid OpenRouter API key (starts with sk-or-).',
      });
      return;
    }

    try {
      setIsSaving(true);
      setFeedbackMessage(null);
      setTestResult(null);

      const res = await fetch('/api/llm/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKeyInput.trim() }),
      });

      // Clear input state immediately to avoid holding key in client memory
      setApiKeyInput('');

      if (res.ok) {
        const updatedStatus: LLMStatus = await res.json();
        setStatus(updatedStatus);
        if (onStatusChange) onStatusChange(updatedStatus.is_configured);
        setFeedbackMessage({
          type: 'success',
          text: 'OpenRouter key safely received and stored in server memory.',
        });
      } else {
        const errData = await res.json().catch(() => ({}));
        setFeedbackMessage({
          type: 'error',
          text: errData.detail || 'Failed to save key to server memory.',
        });
      }
    } catch (err: unknown) {
      setFeedbackMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Network error communicating with server.',
      });
    } finally {
      setIsSaving(false);
    }
  };

  // Test OpenRouter authentication through backend without exposing key
  const handleTestConnection = async () => {
    try {
      setIsTesting(true);
      setTestResult(null);
      setFeedbackMessage(null);

      const res = await fetch('/api/llm/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const data: TestResult = await res.json();
      setTestResult(data);
    } catch (err: unknown) {
      setTestResult({
        success: false,
        message: err instanceof Error ? err.message : 'Failed to reach test endpoint.',
      });
    } finally {
      setIsTesting(false);
    }
  };

  // Clear key from backend memory
  const handleClearKey = async () => {
    try {
      setIsClearing(true);
      setTestResult(null);
      setFeedbackMessage(null);

      const res = await fetch('/api/llm/key', {
        method: 'DELETE',
      });

      if (res.ok) {
        const clearedStatus: LLMStatus = await res.json();
        setStatus(clearedStatus);
        if (onStatusChange) onStatusChange(false);
        setFeedbackMessage({
          type: 'success',
          text: 'Key cleared from active server memory.',
        });
      }
    } catch {
      setFeedbackMessage({
        type: 'error',
        text: 'Failed to clear key from server memory.',
      });
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl shadow-2xl border border-stone-200 w-full max-w-xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="px-6 py-5 border-b border-stone-100 flex items-center justify-between bg-stone-50/70">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-pink-100 text-[#9D174D] flex items-center justify-center shadow-xs">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-stone-900 tracking-tight flex items-center gap-2">
                Secure LLM Settings
                <span className="text-[11px] font-semibold tracking-wide uppercase px-2 py-0.5 rounded-full bg-stone-200 text-stone-700">
                  Teacher / Admin
                </span>
              </h2>
              <p className="text-xs text-stone-500">
                In-memory credential binding for examination generation
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-stone-400 hover:text-stone-700 p-2 rounded-lg hover:bg-stone-200/60 transition-colors"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-6">
          {/* Provider & Model Metadata Bar */}
          <div className="grid grid-cols-2 gap-3 p-3.5 bg-stone-50 rounded-xl border border-stone-200/80 text-xs">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-[#9D174D]" />
              <div>
                <span className="text-stone-500 block">LLM Provider</span>
                <span className="font-semibold text-stone-900 capitalize">
                  {status?.provider || 'OpenRouter'}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-600" />
              <div>
                <span className="text-stone-500 block">Assigned Model</span>
                <span className="font-mono font-semibold text-stone-900">
                  {status?.model || 'openrouter/free'}
                </span>
              </div>
            </div>
          </div>

          {/* Current Configuration Status Banner */}
          {status && (
            <div
              className={`p-4 rounded-xl border flex items-start gap-3 transition-colors ${
                status.is_configured
                  ? 'bg-emerald-50/80 border-emerald-200 text-emerald-950'
                  : 'bg-amber-50/80 border-amber-200 text-amber-950'
              }`}
            >
              {status.is_configured ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              )}
              <div className="flex-1 text-xs">
                <div className="font-semibold text-sm flex items-center justify-between">
                  <span>{status.status_label}</span>
                  {status.is_configured && (
                    <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-medium">
                      <Server className="w-3 h-3" /> Server RAM
                    </span>
                  )}
                </div>
                {status.is_configured && status.masked_key ? (
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-stone-600 font-medium">Active Key:</span>
                    <code className="bg-white/90 border border-emerald-300/80 px-2 py-0.5 rounded font-mono text-[11px] text-emerald-900">
                      {status.masked_key}
                    </code>
                  </div>
                ) : (
                  <p className="mt-1 text-amber-800/90 leading-relaxed">
                    No active OpenRouter key found. Enter your OpenRouter key below to enable
                    automated question generation.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Key Input Form */}
          <form onSubmit={handleSaveKey} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-stone-800 mb-1.5 flex items-center justify-between">
                <span>Enter OpenRouter API Key</span>
                <span className="text-[11px] text-stone-400 font-normal">
                  Prefix: <code className="text-stone-600">sk-or-v1-...</code>
                </span>
              </label>

              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-stone-400">
                  <Key className="w-4 h-4" />
                </div>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder="Paste your key here (e.g. sk-or-v1-xxxxxxxx...)"
                  autoComplete="off"
                  spellCheck="false"
                  className="w-full pl-9 pr-10 py-2.5 bg-white border border-stone-300 rounded-xl text-xs font-mono focus:outline-none focus:ring-2 focus:ring-[#9D174D]/30 focus:border-[#9D174D] transition-all text-stone-900 placeholder:text-stone-400"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-stone-400 hover:text-stone-600"
                  aria-label={showPassword ? 'Hide key' : 'Show key'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Zero-Storage Security Guarantee Card */}
            <div className="p-3 bg-stone-50 border border-stone-200/80 rounded-xl flex items-start gap-2.5 text-[11px] text-stone-600 leading-relaxed">
              <Lock className="w-4 h-4 text-[#9D174D] shrink-0 mt-0.5" />
              <div>
                <strong className="text-stone-800 block">Security Guarantee:</strong>
                Your API key is <span className="font-semibold text-stone-900">never</span> saved in{' '}
                <code className="text-stone-700">localStorage</code> or{' '}
                <code className="text-stone-700">sessionStorage</code>. It is transmitted over
                HTTPS directly into active FastAPI server RAM for the current session and is never
                written to disk or database.
              </div>
            </div>

            {/* Form Action Buttons */}
            <div className="flex items-center gap-2 pt-1">
              <button
                type="submit"
                disabled={isSaving || !apiKeyInput.trim() || apiKeyInput.trim().length < 10}
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-[#9D174D] hover:bg-[#83133E] disabled:bg-stone-300 text-white text-xs font-semibold rounded-xl transition-all shadow-xs cursor-pointer disabled:cursor-not-allowed"
              >
                {isSaving ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Securing Key in RAM...</span>
                  </>
                ) : (
                  <>
                    <ShieldCheck className="w-4 h-4" />
                    <span>Save to Server Memory</span>
                  </>
                )}
              </button>

              {status?.is_configured && (
                <button
                  type="button"
                  onClick={handleClearKey}
                  disabled={isClearing}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-2.5 bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-medium rounded-xl border border-rose-200 transition-colors cursor-pointer disabled:opacity-50"
                  title="Evict key from server memory"
                >
                  <Trash2 className="w-4 h-4" />
                  <span>Clear Key</span>
                </button>
              )}
            </div>
          </form>

          {/* Feedback Message */}
          {feedbackMessage && (
            <div
              className={`p-3 rounded-xl text-xs font-medium border flex items-center gap-2 animate-in fade-in duration-150 ${
                feedbackMessage.type === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-rose-50 border-rose-200 text-rose-800'
              }`}
            >
              {feedbackMessage.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
              )}
              <span>{feedbackMessage.text}</span>
            </div>
          )}

          {/* Connection Test Section */}
          <div className="border-t border-stone-200 pt-5 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xs font-bold text-stone-900">Verify OpenRouter Connection</h3>
                <p className="text-[11px] text-stone-500">
                  Sends an authentication probe to OpenRouter without exposing your key
                </p>
              </div>
              <button
                type="button"
                onClick={handleTestConnection}
                disabled={isTesting || !status?.is_configured}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-stone-900 hover:bg-stone-800 disabled:bg-stone-200 text-white disabled:text-stone-400 text-xs font-medium rounded-xl transition-all cursor-pointer disabled:cursor-not-allowed shadow-xs"
              >
                {isTesting ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Verifying...</span>
                  </>
                ) : (
                  <>
                    <Zap className="w-3.5 h-3.5 text-amber-400" />
                    <span>Test Connection</span>
                  </>
                )}
              </button>
            </div>

            {testResult && (
              <div
                className={`p-3.5 rounded-xl border text-xs leading-relaxed space-y-1 ${
                  testResult.success
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                    : 'bg-rose-50 border-rose-200 text-rose-900'
                }`}
              >
                <div className="flex items-center gap-2 font-semibold">
                  {testResult.success ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-rose-600" />
                  )}
                  <span>
                    {testResult.success
                      ? 'Connection Successful'
                      : 'Connection Verification Failed'}
                  </span>
                  {testResult.latency_ms !== undefined && (
                    <span className="ml-auto font-mono text-[10px] px-1.5 py-0.5 rounded bg-white/80 border border-stone-200 text-stone-600">
                      {testResult.latency_ms}ms
                    </span>
                  )}
                </div>
                <p className="text-[11px] opacity-90 pl-6">{testResult.message}</p>
              </div>
            )}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3.5 border-t border-stone-100 bg-stone-50 flex items-center justify-between text-[11px] text-stone-500">
          <span>Model: {status?.model || 'openrouter/free'}</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-white hover:bg-stone-100 border border-stone-200 rounded-lg text-xs font-medium text-stone-700 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
