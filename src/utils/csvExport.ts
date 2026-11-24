import type { ExamResult } from '../types';

/**
 * Escapes a single CSV cell per RFC 4180 and neutralizes spreadsheet formula injection
 * (cells beginning with =, +, -, @, \t, or \r, including after leading spaces).
 */
export function escapeCsvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const isFormulaTrigger =
    /^[=+\-@\t\r]/.test(raw) ||
    /^[=+\-@\t\r]/.test(normalized) ||
    /^[=+\-@]/.test(normalized.trimStart());
  const safeValue = isFormulaTrigger ? `'${normalized}` : normalized;
  const escapedQuotes = safeValue.replace(/"/g, '""');
  return `"${escapedQuotes}"`;
}

export function buildExamResultsCsv(results: ExamResult[]): string {
  const headers = [
    'Attempt ID',
    'Student Name',
    'Exam Title',
    'Score',
    'Total Questions',
    'Percentage',
    'Passed',
    'Date'
  ];

  const rows = results.map(r => [
    escapeCsvCell(r.attemptId),
    escapeCsvCell(r.studentName),
    escapeCsvCell(r.examTitleEn),
    escapeCsvCell(r.finalScore),
    escapeCsvCell(r.totalQuestions),
    escapeCsvCell(`${r.percentage}%`),
    escapeCsvCell(r.passed ? 'PASSED' : 'FAILED'),
    escapeCsvCell(r.submittedAt)
  ]);

  return [headers.map(h => escapeCsvCell(h)).join(','), ...rows.map(row => row.join(','))].join('\n');
}
