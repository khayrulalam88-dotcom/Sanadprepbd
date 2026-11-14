import React, { useState, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { PreviousQuestion } from '../types';
import { 
  parsePreviousQuestionsCsv, 
  generateSamplePreviousQuestionsCsv, 
  PreviousQuestionCsvValidationResult 
} from '../utils/csvParser';
import { 
  Upload, 
  Download, 
  FileSpreadsheet, 
  CheckCircle2, 
  AlertTriangle, 
  XCircle, 
  Trash2, 
  Search, 
  Scale, 
  RotateCcw,
  Sparkles,
  Database,
  Eye,
  Check,
  FileCheck
} from 'lucide-react';

export const PreviousQuestionsAdminManager: React.FC = () => {
  const { 
    previousQuestions, 
    batchImportPreviousQuestions, 
    deletePreviousQuestion, 
    t 
  } = useApp();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFileName, setSelectedFileName] = useState<string>('');
  const [validationResult, setValidationResult] = useState<PreviousQuestionCsvValidationResult | null>(null);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [uploadStatus, setUploadStatus] = useState<{
    success: boolean;
    message: string;
    count?: number;
  } | null>(null);

  // Filter state for existing questions list
  const [filterYear, setFilterYear] = useState<number | 'all'>('all');
  const [filterSubject, setFilterSubject] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Handle CSV File Selection
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setSelectedFileName(file.name);
    setUploadStatus(null);

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (text) {
        const result = parsePreviousQuestionsCsv(text, previousQuestions);
        setValidationResult(result);
      }
    };
    reader.readAsText(file);
  };

  // Download Sample CSV Template
  const handleDownloadTemplate = () => {
    const csvContent = generateSamplePreviousQuestionsCsv();
    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', 'sanadprep_previous_questions_template.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Upload parsed questions to Firestore
  const handleExecuteBatchUpload = async () => {
    if (!validationResult || validationResult.questionsToSave.length === 0) return;

    setIsUploading(true);
    setUploadStatus(null);

    try {
      const res = await batchImportPreviousQuestions(validationResult.questionsToSave);

      if (res.failureCount === 0) {
        setUploadStatus({
          success: true,
          message: `সফলভাবে ${res.successCount} টি প্রশ্ন Firebase Firestore-এ আপলোড সম্পন্ন হয়েছে!`,
          count: res.successCount
        });
        setValidationResult(null);
        setSelectedFileName('');
        if (fileInputRef.current) fileInputRef.current.value = '';
      } else {
        setUploadStatus({
          success: false,
          message: `${res.successCount} টি সফল, কিন্তু ${res.failureCount} টি আপলোডে সমস্যা হয়েছে। এরর: ${res.errors.join(', ')}`
        });
      }
    } catch (err: any) {
      setUploadStatus({
        success: false,
        message: `আপলোডে ত্রুটি দেখা দিয়েছে: ${err?.message || 'Unknown error'}`
      });
    } finally {
      setIsUploading(false);
    }
  };

  // Filter existing questions
  const filteredList = previousQuestions.filter(q => {
    if (filterYear !== 'all' && q.year !== filterYear) return false;
    if (filterSubject !== 'all' && !q.subject.toLowerCase().includes(filterSubject.toLowerCase())) return false;
    if (searchQuery.trim()) {
      const full = (q.question + ' ' + (q.explanation || '') + ' ' + (q.legalSection || '')).toLowerCase();
      if (!full.includes(searchQuery.toLowerCase())) return false;
    }
    return true;
  });

  return (
    <div className="space-y-8">

      {/* 1. Header & CSV Upload Card */}
      <div className="bg-white rounded-3xl border border-slate-200 p-6 sm:p-8 shadow-xs">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-100 pb-6 mb-6">
          <div>
            <span className="px-3 py-1 rounded-full text-xs font-bold bg-[#102A43] text-amber-400 uppercase tracking-wider">
              Bar Council Question Importer
            </span>
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900 mt-2 flex items-center gap-2">
              <FileSpreadsheet className="w-6 h-6 text-emerald-600" />
              {t('বিগত সালের প্রশ্নাবলি ও CSV বাল্ক ইমপোর্ট', 'Previous Year Questions & CSV Bulk Import')}
            </h2>
            <p className="text-slate-600 text-xs sm:text-sm mt-1">
              {t(
                '২০২০, ২০২২, ২০২৩ ও ২০২৫ সালের প্রশ্ন সম্বলিত CSV ফাইল আপলোড করে এক ক্লিকে সরাসরি ফায়ারবেস ফায়ারস্টোরে সেভ করুন।',
                'Upload CSV files containing past questions (2020, 2022, 2023, 2025) and batch-write directly to Firestore.'
              )}
            </p>
          </div>

          <button
            onClick={handleDownloadTemplate}
            className="px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs sm:text-sm font-bold flex items-center gap-2 transition cursor-pointer self-start md:self-center border border-slate-200 shrink-0"
          >
            <Download className="w-4 h-4 text-slate-600" />
            <span>{t('স্যাম্পল CSV টেমপ্লেট ডাউনলোড', 'Download CSV Template')}</span>
          </button>
        </div>

        {/* Upload Zone */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-center">
          <div className="md:col-span-2">
            <div 
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-slate-300 hover:border-amber-500 hover:bg-amber-50/30 rounded-2xl p-6 text-center transition cursor-pointer group"
            >
              <input 
                ref={fileInputRef}
                type="file" 
                accept=".csv,text/csv" 
                onChange={handleFileChange} 
                className="hidden" 
              />
              <div className="w-12 h-12 rounded-xl bg-emerald-50 text-emerald-600 group-hover:scale-110 mx-auto mb-3 flex items-center justify-center transition">
                <Upload className="w-6 h-6" />
              </div>
              <h4 className="font-bold text-slate-800 text-sm sm:text-base">
                {selectedFileName ? selectedFileName : t('CSV ফাইল নির্বাচন করতে এখানে ক্লিক করুন', 'Click to choose your CSV file')}
              </h4>
              <p className="text-xs text-slate-500 mt-1">
                {t('সাপোর্টেড কলাম: year, subject, question, optionA, optionB, optionC, optionD, correctAnswer, explanation, legalSection', 'Supported columns: year, subject, question, optionA, optionB, optionC, optionD, correctAnswer, explanation, legalSection')}
              </p>
            </div>
          </div>

          {/* Guidelines Box */}
          <div className="bg-slate-50 rounded-2xl p-4 border border-slate-200 text-xs text-slate-600 space-y-2">
            <div className="font-bold text-slate-800 flex items-center gap-1.5 text-xs">
              <Sparkles className="w-3.5 h-3.5 text-amber-500" />
              <span>{t('CSV ফাইল তৈরির নিয়মাবলী:', 'CSV Import Rules:')}</span>
            </div>
            <ul className="space-y-1 list-disc list-inside text-slate-600 text-[11px] leading-relaxed">
              <li><strong>year:</strong> ২০২০, ২০২২, ২০২৩ বা ২০২৫ উল্লেখ করুন।</li>
              <li><strong>correctAnswer:</strong> অপশনের সম্পূর্ণ টেক্সট অথবা A, B, C, D (বা ক, খ, গ, ঘ) লিখুন।</li>
              <li><strong>legalSection:</strong> আইনের সংশ্লিষ্ট ধারা/অর্ডার উল্লেখ করুন।</li>
              <li><strong>explanation:</strong> শিক্ষার্থীদের জন্য স্পষ্ট ব্যাখ্যা দিন।</li>
            </ul>
          </div>
        </div>

        {/* Upload Status Banner */}
        {uploadStatus && (
          <div className={`mt-6 p-4 rounded-2xl border flex items-center gap-3 text-sm font-semibold ${
            uploadStatus.success 
              ? 'bg-emerald-50 border-emerald-300 text-emerald-900' 
              : 'bg-rose-50 border-rose-300 text-rose-900'
          }`}>
            {uploadStatus.success ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
            ) : (
              <XCircle className="w-5 h-5 text-rose-600 shrink-0" />
            )}
            <span>{uploadStatus.message}</span>
          </div>
        )}

        {/* Validation & Preview Card */}
        {validationResult && (
          <div className="mt-6 pt-6 border-t border-slate-200 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50 p-4 rounded-2xl border border-slate-200">
              <div className="flex flex-wrap items-center gap-4 text-xs">
                <div>
                  <span className="text-slate-500">মোট সারি:</span>{' '}
                  <span className="font-bold text-slate-900">{validationResult.totalRows}</span>
                </div>
                <div className="flex items-center gap-1 text-emerald-600 font-bold">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>বৈধ প্রশ্ন: {validationResult.validCount}</span>
                </div>
                {validationResult.invalidCount > 0 && (
                  <div className="flex items-center gap-1 text-rose-600 font-bold">
                    <XCircle className="w-4 h-4" />
                    <span>ত্রুটিযুক্ত সারি: {validationResult.invalidCount}</span>
                  </div>
                )}
                {validationResult.duplicateCount > 0 && (
                  <div className="flex items-center gap-1 text-amber-600 font-bold">
                    <AlertTriangle className="w-4 h-4" />
                    <span>পুনরাবৃত্তি: {validationResult.duplicateCount}</span>
                  </div>
                )}
              </div>

              <button
                onClick={handleExecuteBatchUpload}
                disabled={isUploading || validationResult.validCount === 0}
                className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs sm:text-sm shadow-md transition disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer shrink-0"
              >
                <Database className="w-4 h-4" />
                <span>
                  {isUploading ? t('আপলোড হচ্ছে...', 'Uploading to Firestore...') : t('Firestore-এ ব্যাচ আপলোড করুন', 'Save to Firestore Batch')}
                </span>
              </button>
            </div>

            {/* Preview table for parsed rows */}
            <div className="overflow-x-auto border border-slate-200 rounded-2xl max-h-80 overflow-y-auto">
              <table className="w-full text-left text-xs text-slate-700">
                <thead className="bg-slate-100 sticky top-0 text-[11px] font-bold text-slate-600 uppercase border-b border-slate-200">
                  <tr>
                    <th className="p-3">#</th>
                    <th className="p-3">সাল</th>
                    <th className="p-3">আইন / বিষয়</th>
                    <th className="p-3">প্রশ্ন</th>
                    <th className="p-3">সঠিক উত্তর</th>
                    <th className="p-3">আইনি ধারা</th>
                    <th className="p-3">স্ট্যাটাস</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {validationResult.rows.map((row) => (
                    <tr 
                      key={row.rowNumber} 
                      className={`hover:bg-slate-50/80 ${!row.isValid ? 'bg-rose-50/40' : ''}`}
                    >
                      <td className="p-3 font-mono font-bold text-slate-400">{row.rowNumber}</td>
                      <td className="p-3">
                        <span className="px-2 py-0.5 rounded-md bg-amber-100 text-amber-900 font-bold">
                          {row.year}
                        </span>
                      </td>
                      <td className="p-3 font-semibold text-slate-800 whitespace-nowrap">{row.subject}</td>
                      <td className="p-3 font-medium text-slate-900 min-w-[200px] max-w-xs truncate" title={row.question}>
                        {row.question}
                      </td>
                      <td className="p-3 font-bold text-emerald-700 whitespace-nowrap">{row.correctAnswer}</td>
                      <td className="p-3 font-mono text-[11px] text-slate-500 whitespace-nowrap">{row.legalSection}</td>
                      <td className="p-3 whitespace-nowrap">
                        {row.isValid ? (
                          <span className="text-emerald-600 font-bold flex items-center gap-1">
                            <Check className="w-3.5 h-3.5" /> বৈধ
                          </span>
                        ) : (
                          <span className="text-rose-600 font-bold flex items-center gap-1" title={row.errors.join(', ')}>
                            <XCircle className="w-3.5 h-3.5" /> {row.errors[0]}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* 2. Questions Database Explorer */}
      <div className="bg-white rounded-3xl border border-slate-200 p-6 sm:p-8 shadow-xs space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <Database className="w-5 h-5 text-amber-500" />
              {t('সংরক্ষিত বিগত সালের প্রশ্ন সম্ভার', 'Stored Previous Questions')}
            </h3>
            <p className="text-xs text-slate-500">
              {t('বর্তমানে মোট সংরক্ষিত রয়েছে:', 'Currently stored:')}{' '}
              <span className="font-bold text-slate-900">{previousQuestions.length}</span> টি প্রশ্ন
            </p>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={filterYear}
              onChange={(e) => setFilterYear(e.target.value === 'all' ? 'all' : Number(e.target.value))}
              className="px-3 py-1.5 rounded-xl border border-slate-200 text-xs font-semibold bg-slate-50 text-slate-700 focus:outline-none"
            >
              <option value="all">সকল সাল</option>
              <option value="2025">২০২৫ সাল ({previousQuestions.filter(q => q.year === 2025).length})</option>
              <option value="2023">২০২৩ সাল ({previousQuestions.filter(q => q.year === 2023).length})</option>
              <option value="2022">২০২২ সাল ({previousQuestions.filter(q => q.year === 2022).length})</option>
              <option value="2020">২০২০ সাল ({previousQuestions.filter(q => q.year === 2020).length})</option>
            </select>

            <select
              value={filterSubject}
              onChange={(e) => setFilterSubject(e.target.value)}
              className="px-3 py-1.5 rounded-xl border border-slate-200 text-xs font-semibold bg-slate-50 text-slate-700 focus:outline-none"
            >
              <option value="all">সকল আইন</option>
              <option value="Civil Procedure">দেওয়ানী কার্যবিধি</option>
              <option value="Criminal Procedure">ফৌজদারী কার্যবিধি</option>
              <option value="Penal Code">দণ্ডবিধি</option>
              <option value="Evidence">সাক্ষ্য আইন</option>
              <option value="Specific Relief">সুনির্দিষ্ট প্রতিকার আইন</option>
              <option value="Limitation">তামাদি আইন</option>
              <option value="Bar Council">বার কাউন্সিল বিধিমালা</option>
            </select>
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="প্রশ্নের যেকোনো অংশ বা আইনি ধারা দিয়ে খুঁজুন..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:outline-none focus:ring-2 focus:ring-amber-500"
          />
        </div>

        {/* List */}
        <div className="space-y-3">
          {filteredList.length === 0 ? (
            <div className="p-8 text-center text-slate-400 text-xs">
              কোনো প্রশ্ন পাওয়া যায়নি।
            </div>
          ) : (
            filteredList.map((q, idx) => (
              <div 
                key={q.id}
                className="border border-slate-200 rounded-2xl p-4 sm:p-5 hover:border-slate-300 transition-all bg-white"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-[#102A43] text-amber-400">
                        #{idx + 1}
                      </span>
                      <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-100 text-amber-900">
                        {q.year}
                      </span>
                      <span className="text-xs font-semibold text-slate-700">
                        {q.subject}
                      </span>
                      {q.legalSection && (
                        <span className="text-[11px] text-slate-500 bg-slate-100 px-2 py-0.5 rounded-md">
                          {q.legalSection}
                        </span>
                      )}
                    </div>
                    <h4 className="text-sm font-semibold text-slate-900 mt-1">
                      {q.question}
                    </h4>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => setExpandedId(expandedId === q.id ? null : q.id)}
                      className="p-1.5 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition cursor-pointer"
                      title="বিস্তারিত দেখুন"
                    >
                      <Eye className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`আপনি কি এই প্রশ্নটি মুছে ফেলতে চান?`)) {
                          deletePreviousQuestion(q.id);
                        }
                      }}
                      className="p-1.5 rounded-lg text-rose-500 hover:text-rose-700 hover:bg-rose-50 transition cursor-pointer"
                      title="মুছে ফেলুন"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Expanded Details */}
                {expandedId === q.id && (
                  <div className="mt-3 pt-3 border-t border-slate-100 text-xs space-y-2 bg-slate-50/70 p-3 rounded-xl animate-fadeIn">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {q.options.map((opt: string, oIdx: number) => (
                        <div 
                          key={oIdx} 
                          className={`p-2 rounded-lg border text-xs ${
                            opt.trim() === q.correctAnswer.trim()
                              ? 'bg-emerald-50 border-emerald-300 font-bold text-emerald-950'
                              : 'bg-white border-slate-200 text-slate-700'
                          }`}
                        >
                          <span className="font-bold mr-1">{['ক', 'খ', 'গ', 'ঘ'][oIdx]}:</span> {opt}
                        </div>
                      ))}
                    </div>
                    <div className="pt-2 text-slate-700">
                      <strong>ব্যাখ্যা:</strong> {q.explanation}
                    </div>
                    <div className="text-[10px] text-slate-400">
                      উৎস: {q.source}
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

    </div>
  );
};
