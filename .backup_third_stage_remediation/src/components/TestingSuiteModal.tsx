import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { 
  X, 
  CheckCircle2, 
  XCircle, 
  Play, 
  RotateCcw, 
  ShieldCheck, 
  Terminal,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { runAllTestScenarios, TestScenarioResult } from '../utils/testScenarios';

export const TestingSuiteModal: React.FC = () => {
  const { language, t, showTestRunner, setShowTestRunner } = useApp();
  const [testResults, setTestResults] = useState<TestScenarioResult[]>([]);
  const [running, setRunning] = useState<boolean>(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const executeTests = () => {
    setRunning(true);
    setTimeout(() => {
      const results = runAllTestScenarios();
      setTestResults(results);
      setRunning(false);
    }, 300);
  };

  useEffect(() => {
    if (showTestRunner && testResults.length === 0) {
      executeTests();
    }
  }, [showTestRunner]);

  if (!showTestRunner) return null;

  const passedCount = testResults.filter(r => r.passed).length;
  const allPassed = testResults.length > 0 && passedCount === testResults.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-xs">
      <div className="bg-white rounded-3xl max-w-3xl w-full p-6 sm:p-8 shadow-2xl border border-slate-100 max-h-[90vh] flex flex-col relative animate-in fade-in zoom-in-95">
        
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#102A43] text-[#D4AF37] flex items-center justify-center font-mono">
              <Terminal className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-[#102A43]">
                Sanad Prep BD • {t('সাবস্ক্রিপশন, পেমেন্ট ও সিকিউরিটি ভ্যালিডেটর (Workflows 1-10)', 'Subscription, Payment & Security Validator (Workflows 1-10)')}
              </h2>
              <p className="text-xs text-slate-500">
                {t('প্যাকেজ A, B ও C, ৯০/৩৬৫ দিন মেয়াদ, এক্সাম পাস পলিসি, সিঙ্গেল একটিভ সেশন ও স্কোরিং স্বয়ংক্রিয় যাচাই', 'Automated verification of Packages A, B & C, 90d/365d expiry, Exam Pass policies, single-active-session protection, and scoring')}
              </p>
            </div>
          </div>

          <button 
            onClick={() => setShowTestRunner(false)}
            className="p-1 rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-100 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Status Bar */}
        <div className="py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className={`px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1.5 ${
              allPassed 
                ? 'bg-emerald-100 text-emerald-800 border border-emerald-200' 
                : 'bg-amber-100 text-amber-800'
            }`}>
              {allPassed ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <ShieldCheck className="w-4 h-4" />}
              <span>{passedCount} / {testResults.length} {t('টেস্ট উত্তীর্ণ (Passed)', 'Tests Passed')}</span>
            </span>
          </div>

          <button
            onClick={executeTests}
            disabled={running}
            className="px-4 py-2 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] font-bold text-xs flex items-center gap-1.5 transition disabled:opacity-50 cursor-pointer"
          >
            <RotateCcw className={`w-3.5 h-3.5 ${running ? 'animate-spin' : ''}`} />
            <span>{t('পুনরায় টেস্ট রান করুন', 'Re-run Tests')}</span>
          </button>
        </div>

        {/* Tests List */}
        <div className="overflow-y-auto flex-1 space-y-3 pr-1">
          {testResults.map((tResult) => {
            const isExpanded = expandedId === tResult.id;

            return (
              <div 
                key={tResult.id}
                className={`p-4 rounded-2xl border transition ${
                  tResult.passed 
                    ? 'border-emerald-200 bg-emerald-50/20' 
                    : 'border-rose-300 bg-rose-50/20'
                }`}
              >
                <div 
                  className="flex items-start justify-between gap-3 cursor-pointer"
                  onClick={() => setExpandedId(isExpanded ? null : tResult.id)}
                >
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5">
                      {tResult.passed ? (
                        <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                      ) : (
                        <XCircle className="w-5 h-5 text-rose-600" />
                      )}
                    </span>

                    <div>
                      <h4 className="font-bold text-slate-900 text-xs sm:text-sm">
                        {tResult.name}
                      </h4>
                      <p className="text-xs text-slate-600 mt-0.5">
                        {tResult.description}
                      </p>
                    </div>
                  </div>

                  <span className="text-slate-400">
                    {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </span>
                </div>

                {isExpanded && (
                  <div className="mt-3 pt-3 border-t border-slate-200/60 text-xs font-mono space-y-1.5 bg-white/70 p-3 rounded-xl">
                    <div>
                      <span className="text-slate-400 uppercase text-[10px] block font-sans font-bold">EXPECTED:</span>
                      <span className="text-slate-700">{tResult.expected}</span>
                    </div>
                    <div>
                      <span className="text-slate-400 uppercase text-[10px] block font-sans font-bold">ACTUAL:</span>
                      <span className={tResult.passed ? 'text-emerald-700 font-semibold' : 'text-rose-700 font-semibold'}>
                        {tResult.actual}
                      </span>
                    </div>
                    {tResult.details && (
                      <div className="pt-2">
                        <span className="text-slate-400 uppercase text-[10px] block font-sans font-bold">PAYLOAD DUMP:</span>
                        <pre className="text-[11px] text-slate-600 overflow-x-auto bg-slate-50 p-2 rounded border border-slate-200">
                          {JSON.stringify(tResult.details, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="pt-4 border-t border-slate-100 flex items-center justify-end">
          <button
            onClick={() => setShowTestRunner(false)}
            className="px-5 py-2 rounded-xl bg-slate-900 text-white font-bold text-xs"
          >
            {t('বন্ধ করুন', 'Close')}
          </button>
        </div>

      </div>
    </div>
  );
};
