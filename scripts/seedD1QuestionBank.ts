import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Exam } from '../src/types/index.ts';
import type { ServerQuestion } from '../worker/types.ts';
import examsMeta from '../src/data/initialExamsMeta.json' with { type: 'json' };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

function sqlEscape(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildD1SeedSqlChunks(options?: {
  questions?: ServerQuestion[];
  exams?: Exam[];
  versionToken?: string;
  syncedAtIso?: string;
  chunkSize?: number;
}): string[] {
  const questionsPath = path.join(ROOT_DIR, 'server', 'data', 'questionBankFull.json');
  const questions: ServerQuestion[] =
    options?.questions ||
    (JSON.parse(fs.readFileSync(questionsPath, 'utf-8')) as ServerQuestion[]);
  const exams: Exam[] =
    options?.exams ||
    ([...(examsMeta.modelTests30 as Exam[]), ...(examsMeta.subjectPracticeTests as Exam[])]);

  const nowIso = options?.syncedAtIso || new Date().toISOString();
  const versionToken = options?.versionToken || `seed_${Date.now()}`;
  const chunkSize = options?.chunkSize ?? 150;

  const chunks: string[] = [];

  for (let i = 0; i < questions.length; i += chunkSize) {
    const slice = questions.slice(i, i + chunkSize);
    const lines: string[] = [];
    if (i === 0) {
      lines.push('DELETE FROM question_bank_cache;');
      lines.push('DELETE FROM question_keys_cache;');
    }
    for (const q of slice) {
      const optionsBnJson = JSON.stringify(q.optionsBn || []);
      const optionsEnJson = JSON.stringify(q.optionsEn || q.optionsBn || []);
      lines.push(
        `INSERT INTO question_bank_cache (id, subject_id, topic_id, question_bn, question_en, options_bn_json, options_en_json, legal_reference, difficulty, status, is_demo_sample, created_at, updated_at, synced_version) VALUES (` +
          `${sqlEscape(q.id)}, ${sqlEscape(q.subjectId)}, ${q.topicId ? sqlEscape(q.topicId) : 'NULL'}, ` +
          `${sqlEscape(q.questionBn)}, ${sqlEscape(q.questionEn || q.questionBn)}, ` +
          `${sqlEscape(optionsBnJson)}, ${sqlEscape(optionsEnJson)}, ` +
          `${sqlEscape(q.legalReference || '')}, ${sqlEscape(q.difficulty || 'medium')}, ` +
          `${sqlEscape(q.status || 'published')}, ${q.isDemoSample ? 1 : 0}, ` +
          `${sqlEscape(q.createdAt || nowIso)}, ${sqlEscape(q.updatedAt || nowIso)}, ${sqlEscape(versionToken)}` +
          `) ON CONFLICT(id) DO UPDATE SET subject_id=excluded.subject_id, topic_id=excluded.topic_id, question_bn=excluded.question_bn, question_en=excluded.question_en, options_bn_json=excluded.options_bn_json, options_en_json=excluded.options_en_json, legal_reference=excluded.legal_reference, difficulty=excluded.difficulty, status=excluded.status, is_demo_sample=excluded.is_demo_sample, updated_at=excluded.updated_at, synced_version=excluded.synced_version;`
      );
      lines.push(
        `INSERT INTO question_keys_cache (question_id, correct_option_index, explanation_bn, explanation_en, legal_reference, updated_at, synced_version) VALUES (` +
          `${sqlEscape(q.id)}, ${Number(q.correctOptionIndex ?? 0)}, ` +
          `${sqlEscape(q.explanationBn || '')}, ${sqlEscape(q.explanationEn || '')}, ` +
          `${sqlEscape(q.legalReference || '')}, ${sqlEscape(q.updatedAt || nowIso)}, ${sqlEscape(versionToken)}` +
          `) ON CONFLICT(question_id) DO UPDATE SET correct_option_index=excluded.correct_option_index, explanation_bn=excluded.explanation_bn, explanation_en=excluded.explanation_en, legal_reference=excluded.legal_reference, updated_at=excluded.updated_at, synced_version=excluded.synced_version;`
      );
    }
    chunks.push(lines.join('\n'));
  }

  const tailLines: string[] = [
    `INSERT INTO question_bank_meta (id, version, version_token, synced_at, question_count) VALUES ('questionBankVersion', ${Date.now()}, ${sqlEscape(versionToken)}, ${sqlEscape(nowIso)}, ${questions.length}) ON CONFLICT(id) DO UPDATE SET version=excluded.version, version_token=excluded.version_token, synced_at=excluded.synced_at, question_count=excluded.question_count;`
  ];
  for (const ex of exams) {
    const isActive = ex.isActive !== undefined ? Boolean(ex.isActive) : !ex.isPaid;
    const normalized = { ...ex, isActive };
    tailLines.push(
      `INSERT INTO edge_exams_cache (id, is_paid, is_active, payload_json, updated_at) VALUES (${sqlEscape(ex.id)}, ${ex.isPaid ? 1 : 0}, ${isActive ? 1 : 0}, ${sqlEscape(JSON.stringify(normalized))}, ${sqlEscape(nowIso)}) ON CONFLICT(id) DO UPDATE SET is_paid=excluded.is_paid, is_active=excluded.is_active, payload_json=excluded.payload_json, updated_at=excluded.updated_at;`
    );
  }
  chunks.push(tailLines.join('\n'));
  return chunks;
}

function main() {
  const outDirArg = process.argv.find(a => a.startsWith('--out-dir='))?.split('=')[1];
  const outDir = outDirArg ? path.resolve(outDirArg) : path.join('/tmp', 'sanad-d1-seed');
  fs.mkdirSync(outDir, { recursive: true });
  const chunks = buildD1SeedSqlChunks();
  chunks.forEach((sql, idx) => {
    const filePath = path.join(outDir, `seed_chunk_${String(idx + 1).padStart(3, '0')}.sql`);
    fs.writeFileSync(filePath, sql, 'utf-8');
  });
  console.log(`Generated ${chunks.length} keyless D1 seed SQL file(s) in ${outDir}`);
}

const isMain =
  typeof process !== 'undefined' &&
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(__filename);
if (isMain) {
  main();
}
