import React, { useState, useRef } from 'react';
import { 
  UploadCloud, 
  FileSpreadsheet, 
  Download, 
  AlertTriangle, 
  CheckCircle2, 
  XCircle, 
  X, 
  FileText, 
  Layers, 
  Check, 
  AlertCircle,
  RefreshCw,
  Eye,
  ArrowRight
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { 
  validateCsvQuestions, 
  generateSampleCsvTemplate, 
  CsvValidationResult, 
  ParsedCsvQuestion 
} from '../utils/csvParser';
import { Question } from '../types';

interface BulkImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportComplete?: (count: number) => void;
}

export const BulkImportModal: React.FC<BulkImportModalProps> = ({ isOpen, onClose, onImportComplete }) => {
  const { language, t, subjects, questions, addQuestion } = useApp();
  
  const [csvContent, setCsvContent] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [fileSize, setFileSize] = useState<string>('');
  const [validationResult, setValidationResult] = useState<CsvValidationResult | null>(null);
  const [filterTab, setFilterTab] = useState<'all' | 'valid' | 'errors' | 'duplicates'>('all');
  
  // Options
  const [skipDuplicates, setSkipDuplicates] = useState<boolean>(true);
  const [skipErrors, setSkipErrors] = useState<boolean>(true);
  
  // Progress & State
  const [isImporting, setIsImporting] = useState<boolean>(false);
  const [importProgress, setImportProgress] = useState<{ current: number; total: number; percent: number }>({
    current: 0,
    total: 0,
    percent: 0
  });
  const [importReport, setImportReport] = useState<{
    completed: boolean;
    importedCount: number;
    skippedDuplicates: number;
    skippedErrors: number;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  // Handle template download
  const handleDownloadTemplate = () => {
    const templateContent = generateSampleCsvTemplate();
    const blob = new Blob([templateContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', 'sanad_prep_questions_bulk_import_template.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Handle file reading
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    processFile(file);
  };

  const processFile = (file: File) => {
    setFileName(file.name);
    setFileSize((file.size / 1024).toFixed(1) + ' KB');
    setImportReport(null);

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (text) {
        setCsvContent(text);
        const result = validateCsvQuestions(text, questions, subjects);
        setValidationResult(result);
      }
    };
    reader.readAsText(file, 'UTF-8');
  };

  // Handle drag and drop
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  // Reset file selection
  const handleReset = () => {
    setCsvContent(null);
    setFileName('');
    setFileSize('');
    setValidationResult(null);
    setImportReport(null);
    setIsImporting(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Execute bulk import in batches with progress updates
  const handleExecuteImport = async () => {
    if (!validationResult) return;

    // Filter rows to import
    const rowsToImport = validationResult.parsedQuestions.filter(q => {
      if (!q.isValid && skipErrors) return false;
      if (q.isDuplicate && skipDuplicates) return false;
      return true;
    });

    if (rowsToImport.length === 0) {
      alert(t('ইমপোর্ট করার উপযোগী কোনো বৈধ প্রশ্ন পাওয়া যায়নি।', 'No valid questions found to import based on your settings.'));
      return;
    }

    setIsImporting(true);
    const total = rowsToImport.length;
    let imported = 0;

    // Process in batches of 5 to allow UI repaint and smooth DB write
    const batchSize = 5;
    for (let i = 0; i < total; i += batchSize) {
      const chunk = rowsToImport.slice(i, i + batchSize);
      
      for (const item of chunk) {
        const newQuestion: Omit<Question, 'id' | 'createdAt' | 'updatedAt'> = {
          subjectId: item.subjectId,
          topicId: item.topic,
          questionBn: item.question,
          questionEn: item.question,
          optionsBn: item.options,
          optionsEn: item.options,
          correctOptionIndex: item.correctOptionIndex,
          explanationBn: item.explanation || item.question,
          explanationEn: item.explanation || item.question,
          legalReference: item.topic || `${item.subjectCode} MCQ Question`,
          difficulty: item.difficulty,
          status: 'published',
          isDemoSample: false
        };

        addQuestion(newQuestion);
        imported++;
      }

      setImportProgress({
        current: Math.min(imported, total),
        total,
        percent: Math.round((Math.min(imported, total) / total) * 100)
      });

      // Small pause to yield to event loop for smooth progress bar rendering
      await new Promise(r => setTimeout(r, 60));
    }

    setIsImporting(false);
    const skippedDups = validationResult.parsedQuestions.filter(q => q.isDuplicate).length;
    const skippedErrs = validationResult.parsedQuestions.filter(q => !q.isValid).length;

    setImportReport({
      completed: true,
      importedCount: imported,
      skippedDuplicates: skipDuplicates ? skippedDups : 0,
      skippedErrors: skipErrors ? skippedErrs : 0
    });

    if (onImportComplete) {
      onImportComplete(imported);
    }
  };

  // Filter questions for the preview table
  const filteredPreview = validationResult?.parsedQuestions.filter(q => {
    if (filterTab === 'valid') return q.isValid && (!q.isDuplicate || !skipDuplicates);
    if (filterTab === 'errors') return !q.isValid;
    if (filterTab === 'duplicates') return q.isDuplicate;
    return true;
  }) || [];

  const eligibleCount = validationResult?.parsedQuestions.filter(q => {
    if (!q.isValid && skipErrors) return false;
    if (q.isDuplicate && skipDuplicates) return false;
    return true;
  }).length || 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
      <div className="bg-white rounded-3xl max-w-4xl w-full max-h-[92vh] flex flex-col shadow-2xl border border-slate-100 overflow-hidden">
        
        {/* Modal Header */}
        <div className="px-6 py-5 bg-[#102A43] text-white flex items-center justify-between border-b border-[#243B53]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-[#243B53] text-[#D4AF37] flex items-center justify-center border border-[#D4AF37]/30">
              <UploadCloud className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-base sm:text-lg text-white">
                {t('বাল্ক প্রশ্ন ইমপোর্ট (CSV Bulk Import Questions)', 'Bulk Import Questions (CSV)')}
              </h3>
              <p className="text-xs text-slate-300">
                {t('একসাথে একাধিক এমসিকিউ প্রশ্ন CSV ফাইলের মাধ্যমে আপলোড করুন', 'Upload multiple MCQs at once using standard CSV format')}
              </p>
            </div>
          </div>

          <button 
            onClick={onClose}
            className="p-1.5 rounded-xl hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          
          {/* Completion Report Screen */}
          {importReport?.completed ? (
            <div className="p-8 text-center space-y-6 max-w-md mx-auto">
              <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-700 mx-auto flex items-center justify-center border-4 border-emerald-200">
                <Check className="w-8 h-8 stroke-[3]" />
              </div>

              <div className="space-y-2">
                <h4 className="text-xl font-bold text-slate-900">
                  {t('প্রশ্নসমূহ সফলভাবে ইমপোর্ট সম্পন্ন হয়েছে!', 'Questions Imported Successfully!')}
                </h4>
                <p className="text-xs sm:text-sm text-slate-600">
                  {t(
                    `মোট ${importReport.importedCount} টি প্রশ্ন ডাটাবেজে সংরক্ষণ করা হয়েছে এবং প্রশ্ন সম্ভারে যুক্ত করা হয়েছে।`,
                    `${importReport.importedCount} questions have been permanently saved to the database and are now live in the Question Bank & Mock Tests.`
                  )}
                </p>
              </div>

              <div className="grid grid-cols-3 gap-2 bg-slate-50 p-4 rounded-2xl border border-slate-200 text-xs text-center">
                <div>
                  <span className="text-slate-400 block text-[10px]">{t('সংরক্ষিত', 'Imported')}</span>
                  <strong className="text-emerald-700 text-base">{importReport.importedCount}</strong>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px]">{t('ডুপ্লিকেট বাদ', 'Duplicates')}</span>
                  <strong className="text-amber-600 text-base">{importReport.skippedDuplicates}</strong>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px]">{t('ত্রুটিপূর্ণ বাদ', 'Invalid')}</span>
                  <strong className="text-rose-600 text-base">{importReport.skippedErrors}</strong>
                </div>
              </div>

              <div className="flex justify-center gap-3 pt-2">
                <button
                  onClick={handleReset}
                  className="px-5 py-2.5 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-50 font-bold text-xs flex items-center gap-2 cursor-pointer"
                >
                  <RefreshCw className="w-4 h-4" />
                  <span>{t('আরেকটি ফাইল আপলোড করুন', 'Upload Another File')}</span>
                </button>

                <button
                  onClick={onClose}
                  className="px-6 py-2.5 rounded-xl bg-[#102A43] text-[#D4AF37] border border-[#D4AF37] font-bold text-xs hover:bg-[#243B53] cursor-pointer"
                >
                  {t('সম্পন্ন ও বন্ধ করুন', 'Done & View Questions')}
                </button>
              </div>
            </div>
          ) : isImporting ? (
            /* Importing Progress View */
            <div className="p-8 text-center space-y-6 max-w-md mx-auto">
              <div className="w-14 h-14 rounded-2xl bg-[#102A43] text-[#D4AF37] mx-auto flex items-center justify-center animate-bounce">
                <FileSpreadsheet className="w-7 h-7" />
              </div>

              <div className="space-y-2">
                <h4 className="text-lg font-bold text-slate-900">
                  {t('প্রশ্নসমূহ ডাটাবেজে সংরক্ষণ করা হচ্ছে...', 'Importing Questions to Database...')}
                </h4>
                <p className="text-xs text-slate-500">
                  {t(
                    `${importProgress.current} / ${importProgress.total} প্রশ্ন প্রসেস করা হয়েছে (${importProgress.percent}%)`,
                    `Processing ${importProgress.current} of ${importProgress.total} questions (${importProgress.percent}%)`
                  )}
                </p>
              </div>

              {/* Progress Bar */}
              <div className="w-full bg-slate-100 rounded-full h-3 overflow-hidden border border-slate-200">
                <div 
                  className="bg-emerald-600 h-full rounded-full transition-all duration-200 ease-out"
                  style={{ width: `${importProgress.percent}%` }}
                />
              </div>
              <span className="text-[11px] text-slate-400 block">
                {t('দয়া করে অপেক্ষা করুন, ব্রাউজার বন্ধ করবেন না...', 'Please wait while data is committed to Firestore...')}
              </span>
            </div>
          ) : !csvContent ? (
            /* Step 1: Upload & Template Download */
            <div className="space-y-6">
              
              {/* Template Card */}
              <div className="bg-amber-50/70 border border-amber-200 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <FileSpreadsheet className="w-4 h-4 text-amber-700" />
                    <h4 className="font-bold text-slate-900 text-sm">
                      {t('CSV টেমপ্লেট ডাউনলোড ও নির্দেশিকা', 'Download Official CSV Template')}
                    </h4>
                  </div>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    {t(
                      'প্রশ্নের সঠিক ফরম্যাট নিশ্চিত করতে নিচের নমুনা CSV ফাইলটি ডাউনলোড করে পূরণ করুন।',
                      'To ensure seamless imports, download our sample CSV with CPC, CrPC & Penal Code questions.'
                    )}
                  </p>
                  <p className="text-[11px] font-mono text-slate-500">
                    Fields: subject, topic, question, optionA, optionB, optionC, optionD, correctAnswer, explanation
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleDownloadTemplate}
                  className="px-4 py-2.5 rounded-xl bg-white border border-amber-300 hover:bg-amber-100/50 text-[#102A43] font-bold text-xs flex items-center gap-2 shadow-xs shrink-0 cursor-pointer"
                >
                  <Download className="w-4 h-4 text-amber-700" />
                  <span>{t('টেমপ্লেট ডাউনলোড (.csv)', 'Download Template')}</span>
                </button>
              </div>

              {/* Drag & Drop Upload Zone */}
              <div 
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-slate-300 hover:border-[#102A43] rounded-3xl p-8 sm:p-12 text-center cursor-pointer bg-slate-50/50 hover:bg-slate-50 transition space-y-4"
              >
                <input 
                  type="file" 
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept=".csv,text/csv"
                  className="hidden" 
                />

                <div className="w-16 h-16 rounded-2xl bg-white border border-slate-200 shadow-xs mx-auto flex items-center justify-center text-[#102A43]">
                  <UploadCloud className="w-8 h-8 text-[#102A43]" />
                </div>

                <div className="space-y-1">
                  <p className="font-bold text-slate-800 text-sm sm:text-base">
                    {t('এখানে CSV ফাইল ড্র্যাগ করুন অথবা ক্লিক করে ফাইল সিলেক্ট করুন', 'Drag & drop your CSV file here or browse from computer')}
                  </p>
                  <p className="text-xs text-slate-500">
                    {t('শুধুমাত্র .csv ফরম্যাট সমর্থিত (UTF-8 এনকোডিংয়ে বাংলা অক্ষর সঠিক থাকে)', 'Supports .csv format with UTF-8 encoding for accurate Bangla text')}
                  </p>
                </div>

                <span className="inline-block px-4 py-2 rounded-xl bg-[#102A43] text-white text-xs font-bold shadow-xs">
                  {t('ফাইল নির্বাচন করুন (Browse File)', 'Browse File')}
                </span>
              </div>
            </div>
          ) : (
            /* Step 2: Validation Preview & Confirmation */
            <div className="space-y-5">
              
              {/* File Info Bar */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50 p-4 rounded-2xl border border-slate-200">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-[#102A43] text-white flex items-center justify-center">
                    <FileText className="w-5 h-5 text-[#D4AF37]" />
                  </div>
                  <div>
                    <h4 className="font-bold text-slate-900 text-sm truncate max-w-xs">{fileName}</h4>
                    <span className="text-xs text-slate-500">{fileSize} • {validationResult?.totalRows} {t('সারি পাওয়া গেছে', 'rows parsed')}</span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleReset}
                  className="px-3 py-1.5 rounded-xl border border-slate-300 hover:bg-white text-slate-600 text-xs font-semibold cursor-pointer shrink-0"
                >
                  {t('অন্য ফাইল দিন', 'Change File')}
                </button>
              </div>

              {/* Summary Metric Cards */}
              {validationResult && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-xs">
                    <span className="text-[11px] text-slate-500 font-semibold block">{t('মোট প্রশ্ন', 'Total Parsed')}</span>
                    <strong className="text-xl font-black text-slate-900">{validationResult.totalRows}</strong>
                  </div>

                  <div className="bg-emerald-50/60 p-3.5 rounded-2xl border border-emerald-200 shadow-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-emerald-800 font-semibold block">{t('বৈধ প্রশ্ন (Valid)', 'Valid')}</span>
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    </div>
                    <strong className="text-xl font-black text-emerald-700">{validationResult.validCount}</strong>
                  </div>

                  <div className="bg-amber-50/60 p-3.5 rounded-2xl border border-amber-200 shadow-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-amber-900 font-semibold block">{t('ডুপ্লিকেট (Duplicates)', 'Duplicates')}</span>
                      <AlertTriangle className="w-4 h-4 text-amber-600" />
                    </div>
                    <strong className="text-xl font-black text-amber-700">{validationResult.duplicateCount}</strong>
                  </div>

                  <div className="bg-rose-50/60 p-3.5 rounded-2xl border border-rose-200 shadow-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-rose-800 font-semibold block">{t('ত্রুটিপূর্ণ (Errors)', 'Errors')}</span>
                      <XCircle className="w-4 h-4 text-rose-600" />
                    </div>
                    <strong className="text-xl font-black text-rose-700">{validationResult.invalidCount}</strong>
                  </div>
                </div>
              )}

              {/* Filter Tabs & Options */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1 border-t border-slate-100">
                {/* Tabs */}
                <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-2xl text-xs font-bold overflow-x-auto">
                  <button
                    onClick={() => setFilterTab('all')}
                    className={`px-3 py-1.5 rounded-xl transition cursor-pointer whitespace-nowrap ${
                      filterTab === 'all' ? 'bg-white text-[#102A43] shadow-xs' : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {t('সকল', 'All')} ({validationResult?.totalRows || 0})
                  </button>
                  <button
                    onClick={() => setFilterTab('valid')}
                    className={`px-3 py-1.5 rounded-xl transition cursor-pointer whitespace-nowrap ${
                      filterTab === 'valid' ? 'bg-white text-emerald-800 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {t('বৈধ', 'Valid')} ({validationResult?.validCount || 0})
                  </button>
                  <button
                    onClick={() => setFilterTab('duplicates')}
                    className={`px-3 py-1.5 rounded-xl transition cursor-pointer whitespace-nowrap ${
                      filterTab === 'duplicates' ? 'bg-white text-amber-800 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {t('ডুপ্লিকেট', 'Duplicates')} ({validationResult?.duplicateCount || 0})
                  </button>
                  <button
                    onClick={() => setFilterTab('errors')}
                    className={`px-3 py-1.5 rounded-xl transition cursor-pointer whitespace-nowrap ${
                      filterTab === 'errors' ? 'bg-white text-rose-800 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {t('ত্রুটিসমূহ', 'Errors')} ({validationResult?.invalidCount || 0})
                  </button>
                </div>

                {/* Import Rule Checkboxes */}
                <div className="flex flex-wrap items-center gap-4 text-xs">
                  <label className="flex items-center gap-2 cursor-pointer font-semibold text-slate-700">
                    <input 
                      type="checkbox"
                      checked={skipDuplicates}
                      onChange={(e) => setSkipDuplicates(e.target.checked)}
                      className="rounded text-[#102A43] focus:ring-[#102A43]"
                    />
                    <span>{t('ডুপ্লিকেট প্রশ্ন বাদ দিন (Skip duplicates)', 'Skip duplicates')}</span>
                  </label>

                  <label className="flex items-center gap-2 cursor-pointer font-semibold text-slate-700">
                    <input 
                      type="checkbox"
                      checked={skipErrors}
                      onChange={(e) => setSkipErrors(e.target.checked)}
                      className="rounded text-[#102A43] focus:ring-[#102A43]"
                    />
                    <span>{t('ভুল সারি বাদ দিন (Skip invalid)', 'Skip invalid')}</span>
                  </label>
                </div>
              </div>

              {/* Table Preview */}
              <div className="border border-slate-200 rounded-2xl overflow-hidden max-h-72 overflow-y-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-100/80 text-slate-700 font-bold uppercase text-[10px] tracking-wider sticky top-0 z-10 border-b border-slate-200">
                    <tr>
                      <th className="py-2.5 px-3">Row</th>
                      <th className="py-2.5 px-3">Subject</th>
                      <th className="py-2.5 px-3">Question</th>
                      <th className="py-2.5 px-3">Ans</th>
                      <th className="py-2.5 px-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredPreview.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-slate-400">
                          {t('এই ফিল্টারে কোনো প্রশ্ন পাওয়া যায়নি।', 'No questions match the selected filter.')}
                        </td>
                      </tr>
                    ) : (
                      filteredPreview.map((q) => (
                        <tr 
                          key={q.rowNumber}
                          className={`hover:bg-slate-50 transition ${!q.isValid ? 'bg-rose-50/40' : q.isDuplicate ? 'bg-amber-50/30' : ''}`}
                        >
                          <td className="py-3 px-3 font-mono font-bold text-slate-500 whitespace-nowrap">
                            #{q.rowNumber}
                          </td>
                          <td className="py-3 px-3 font-mono font-semibold text-[#102A43] whitespace-nowrap">
                            <span className="bg-slate-100 px-1.5 py-0.5 rounded text-[10px]">
                              {q.subjectCode}
                            </span>
                          </td>
                          <td className="py-3 px-3 max-w-md">
                            <p className="font-semibold text-slate-900 line-clamp-1">{q.question}</p>
                            
                            {/* Option snippets */}
                            <div className="text-[10px] text-slate-500 flex flex-wrap gap-2 pt-0.5">
                              <span>A: {q.options[0]?.slice(0, 20)}</span>
                              <span>B: {q.options[1]?.slice(0, 20)}</span>
                              <span>C: {q.options[2]?.slice(0, 20)}</span>
                              <span>D: {q.options[3]?.slice(0, 20)}</span>
                            </div>

                            {/* Error messages if any */}
                            {q.errors.length > 0 && (
                              <div className="mt-1 space-y-0.5">
                                {q.errors.map((err, i) => (
                                  <span key={i} className="text-[11px] font-semibold text-rose-700 flex items-center gap-1">
                                    <AlertCircle className="w-3 h-3 text-rose-500 shrink-0" />
                                    {err}
                                  </span>
                                ))}
                              </div>
                            )}

                            {/* Warning message if duplicate */}
                            {q.isDuplicate && (
                              <span className="text-[11px] font-semibold text-amber-700 flex items-center gap-1 mt-0.5">
                                <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0" />
                                {t('ডাটাবেজে বিদ্যমান (Already exists)', 'Duplicate detected')}
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-3 whitespace-nowrap">
                            <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold text-[11px]">
                              {q.correctAnswer}
                            </span>
                          </td>
                          <td className="py-3 px-3 whitespace-nowrap">
                            {!q.isValid ? (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-rose-100 text-rose-800">
                                Error
                              </span>
                            ) : q.isDuplicate ? (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-amber-100 text-amber-800">
                                Duplicate
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-emerald-100 text-emerald-800">
                                Valid
                              </span>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

        </div>

        {/* Modal Footer */}
        {!importReport?.completed && !isImporting && csvContent && (
          <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="text-xs text-slate-600">
              <span>{t('ইমপোর্টের জন্য প্রস্তুত:', 'Ready to import:')} </span>
              <strong className="text-emerald-700 text-sm font-black">{eligibleCount}</strong>
              <span> {t('টি প্রশ্ন', 'questions')}</span>
            </div>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleReset}
                className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 font-bold text-xs hover:bg-white transition cursor-pointer"
              >
                {t('রিসেট', 'Reset')}
              </button>

              <button
                type="button"
                onClick={handleExecuteImport}
                disabled={eligibleCount === 0}
                className="px-5 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-xs flex items-center gap-2 shadow-xs transition cursor-pointer"
              >
                <Check className="w-4 h-4" />
                <span>{t(`${eligibleCount} টি প্রশ্ন ডাটাবেজে সংরক্ষণ করুন`, `Save ${eligibleCount} Questions to Database`)}</span>
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
};
