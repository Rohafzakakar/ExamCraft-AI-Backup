import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Database Directory & Path Setup
const DATA_DIR = path.resolve(process.cwd(), 'data');
const BACKUPS_DIR = path.resolve(DATA_DIR, 'backups');
const DB_PATH = path.resolve(DATA_DIR, 'examcraft.db');

export interface UserRecord {
  id: string;
  email: string;
  password_hash: string;
  salt: string;
  full_name: string;
  institution: string;
  role: string;
  token_version: number;
  created_at: string;
  updated_at: string;
}

export interface DocumentChunkRecord {
  id: string;
  document_id: string;
  page_number: number;
  chapter?: string | null;
  section?: string | null;
  content: string;
  token_count: number;
  chunk_index: number;
}

export interface DocumentRecord {
  id: string;
  user_id?: string | null;
  session_id?: string | null;
  filename: string;
  file_type: string;
  file_size_bytes: number;
  detected_language: string;
  is_rtl: boolean;
  total_pages: number;
  status: string;
  metadata: {
    chapters?: string[];
    total_characters?: number;
    pages_info?: Array<{ page_number: number; chapter?: string; char_count?: number }>;
  };
  chunks: DocumentChunkRecord[];
  created_at: string;
}

export interface QuestionRecord {
  id: string;
  exam_id: string;
  group_id: string;
  question_order: number;
  question_type: string;
  question_text: string;
  options: string[] | null;
  correct_answer: string;
  explanation: string;
  marks: number;
  difficulty: string;
  bloom_level: string;
  source_document_name: string;
  source_page: number;
  source_chapter?: string | null;
  source_section?: string | null;
  source_chunk_id?: string | null;
  source_evidence: string;
  created_at: string;
  updated_at: string;
}

export interface ExamGroupRecord {
  id: string;
  exam_id: string;
  group_name: string;
  group_order: number;
  questions_count: number;
  questions: QuestionRecord[];
}

export interface ExamRecord {
  id: string;
  user_id?: string | null;
  session_id?: string | null;
  document_id?: string | null;
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
  difficulty_distribution?: Record<string, number>;
  question_types_config?: Record<string, number>;
  groups: ExamGroupRecord[];
  created_at: string;
  updated_at: string;
}

class ExamCraftDatabase {
  private db!: DatabaseSync;

  constructor() {
    this.initDirectoriesAndBackup();
    this.initDatabase();
    this.runMigrations();
    this.seedInitialDataIfEmpty();
  }

  private initDirectoriesAndBackup(): void {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(BACKUPS_DIR)) {
      fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    }

    // Automated rolling backup if database exists
    if (fs.existsSync(DB_PATH)) {
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = path.resolve(BACKUPS_DIR, `examcraft_backup_${timestamp}.db`);
        fs.copyFileSync(DB_PATH, backupFile);

        // Keep only the last 5 backups
        const existingBackups = fs
          .readdirSync(BACKUPS_DIR)
          .filter((f) => f.startsWith('examcraft_backup_') && f.endsWith('.db'))
          .sort();
        if (existingBackups.length > 5) {
          const toDelete = existingBackups.slice(0, existingBackups.length - 5);
          for (const file of toDelete) {
            try {
              fs.unlinkSync(path.resolve(BACKUPS_DIR, file));
            } catch {
              // Ignore unlink errors
            }
          }
        }
      } catch (err: any) {
        console.warn('Backup warning (proceeding with startup):', err?.message);
      }
    }
  }

  private initDatabase(): void {
    this.db = new DatabaseSync(DB_PATH);
    // Enable WAL mode for high concurrency and write safety
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        full_name TEXT NOT NULL,
        institution TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'teacher',
        token_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        session_id TEXT,
        filename TEXT NOT NULL,
        file_type TEXT NOT NULL,
        file_size_bytes INTEGER NOT NULL,
        detected_language TEXT NOT NULL,
        is_rtl INTEGER NOT NULL DEFAULT 0,
        total_pages INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'indexed',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS document_chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        page_number INTEGER NOT NULL,
        chapter TEXT,
        section TEXT,
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL DEFAULT 0,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS exams (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        session_id TEXT,
        document_id TEXT,
        title TEXT NOT NULL,
        subject TEXT NOT NULL,
        institution TEXT,
        teacher_name TEXT,
        grade_level TEXT,
        exam_date TEXT,
        duration_minutes INTEGER NOT NULL DEFAULT 60,
        total_marks REAL NOT NULL DEFAULT 0,
        language TEXT NOT NULL DEFAULT 'en',
        is_rtl INTEGER NOT NULL DEFAULT 0,
        bloom_enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'ready',
        groups_count INTEGER NOT NULL DEFAULT 1,
        questions_count INTEGER NOT NULL DEFAULT 0,
        difficulty_distribution_json TEXT,
        question_types_config_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS exam_groups (
        id TEXT PRIMARY KEY,
        exam_id TEXT NOT NULL,
        group_name TEXT NOT NULL,
        group_order INTEGER NOT NULL,
        questions_count INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS exam_questions (
        id TEXT PRIMARY KEY,
        exam_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        question_order INTEGER NOT NULL,
        question_type TEXT NOT NULL,
        question_text TEXT NOT NULL,
        options_json TEXT,
        correct_answer TEXT NOT NULL,
        explanation TEXT,
        marks REAL NOT NULL DEFAULT 1.0,
        difficulty TEXT NOT NULL DEFAULT 'medium',
        bloom_level TEXT NOT NULL DEFAULT 'understand',
        source_document_name TEXT NOT NULL,
        source_page INTEGER NOT NULL DEFAULT 1,
        source_chapter TEXT,
        source_section TEXT,
        source_chunk_id TEXT,
        source_evidence TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
        FOREIGN KEY (group_id) REFERENCES exam_groups(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);
      CREATE INDEX IF NOT EXISTS idx_documents_session ON documents(session_id);
      CREATE INDEX IF NOT EXISTS idx_exams_user ON exams(user_id);
      CREATE INDEX IF NOT EXISTS idx_exams_session ON exams(session_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(document_id);
      CREATE INDEX IF NOT EXISTS idx_groups_exam ON exam_groups(exam_id);
      CREATE INDEX IF NOT EXISTS idx_questions_exam ON exam_questions(exam_id);
    `);

    try {
      this.db.exec('ALTER TABLE exams ADD COLUMN faculty TEXT;');
    } catch {
      // Column already exists
    }
  }

  private seedInitialDataIfEmpty(): void {
    const checkExams = this.db.prepare('SELECT COUNT(*) as count FROM exams');
    const row = checkExams.get() as { count: number } | undefined;
    if (row && row.count > 0) {
      return; // Already seeded or has user exams
    }

    // Seed Cell Biology Document
    const seedDocId = 'doc-cell-biology-101';
    const seedChunks: DocumentChunkRecord[] = [
      {
        id: 'chunk-cb-1',
        document_id: seedDocId,
        page_number: 1,
        chapter: 'Cell Architecture',
        section: '1.1 The Nucleus and Genetic Repository',
        content:
          'The nucleus is the defining organelle of eukaryotic cells, serving as the repository of hereditary genetic material organized as chromatin fibers. Within the nucleoplasm, the dense nucleolus coordinates the transcription of ribosomal RNA and orchestrates the initial assembly of ribosomal subunits. The nuclear envelope features double lipid bilayers interrupted by nuclear pore complexes that strictly regulate nucleocytoplasmic macromolecular transport.',
        token_count: 75,
        chunk_index: 0,
      },
      {
        id: 'chunk-cb-2',
        document_id: seedDocId,
        page_number: 1,
        chapter: 'Cell Architecture',
        section: '1.2 Ribosomes and Endomembrane System',
        content:
          'Ribosomes are catalytic ribonucleoprotein complexes responsible for protein synthesis through mRNA translation. Bound ribosomes adhere to the rough endoplasmic reticulum, directing nascent polypeptides destined for secretory pathways or membrane integration. The smooth endoplasmic reticulum lacks ribosomes and specializes in lipid synthesis, carbohydrate metabolism, and intracellular calcium sequestration.',
        token_count: 68,
        chunk_index: 1,
      },
      {
        id: 'chunk-cb-3',
        document_id: seedDocId,
        page_number: 2,
        chapter: 'Bioenergetics',
        section: '2.1 Mitochondria and ATP Synthesis',
        content:
          'Mitochondria are double-membraned bioenergetic engines that generate adenosine triphosphate (ATP) via oxidative phosphorylation. The highly convoluted inner mitochondrial membrane forms cristae that harbor the electron transport chain complexes (I-IV) and ATP synthase. Active transport mechanisms across plasma membranes, such as the sodium-potassium ATPase pump, rely strictly on continuous ATP hydrolysis.',
        token_count: 72,
        chunk_index: 2,
      },
      {
        id: 'chunk-cb-4',
        document_id: seedDocId,
        page_number: 2,
        chapter: 'Bioenergetics',
        section: '2.2 Glycolysis and Krebs Cycle',
        content:
          'Glycolysis occurs universally in the cytosol, cleaving one glucose molecule into two pyruvate molecules with a net yield of 2 ATP and 2 NADH. Under aerobic conditions, pyruvate enters the mitochondrial matrix, undergoing oxidative decarboxylation to form acetyl-CoA, which feeds directly into the tricarboxylic acid (Krebs) cycle for complete oxidation.',
        token_count: 66,
        chunk_index: 3,
      },
      {
        id: 'chunk-cb-5',
        document_id: seedDocId,
        page_number: 3,
        chapter: 'Plant Physiology',
        section: '3.1 Photosynthesis and Chloroplast Architecture',
        content:
          'Photosynthesis is the fundamental biological process through which autotrophic organisms convert solar light energy into chemical energy stored in glucose. The light-dependent reactions take place within the thylakoid membranes of chloroplasts, where chlorophyll pigments absorb photons. Water molecules undergo photolysis, yielding protons, electrons, and releasing molecular oxygen as a crucial metabolic byproduct.',
        token_count: 70,
        chunk_index: 4,
      },
    ];

    const seedDoc: DocumentRecord = {
      id: seedDocId,
      user_id: null,
      session_id: 'default',
      filename: 'Cell_Biology_101.pdf',
      file_type: 'application/pdf',
      file_size_bytes: 148520,
      detected_language: 'en',
      is_rtl: false,
      total_pages: 3,
      status: 'indexed',
      metadata: {
        chapters: ['Cell Architecture', 'Bioenergetics', 'Plant Physiology'],
        total_characters: 2450,
        pages_info: [
          { page_number: 1, chapter: 'Cell Architecture', char_count: 850 },
          { page_number: 2, chapter: 'Bioenergetics', char_count: 920 },
          { page_number: 3, chapter: 'Plant Physiology', char_count: 680 },
        ],
      },
      chunks: seedChunks,
      created_at: new Date().toISOString(),
    };

    this.insertDocument(seedDoc);

    // Seed Midterm Exam with 3 Groups
    const examId = 'exam-cell-bio-midterm';
    const groupAId = 'group-a-1';
    const groupBId = 'group-b-2';
    const groupCId = 'group-c-3';

    const groupAQuestions: QuestionRecord[] = [
      {
        id: 'q-a-1',
        exam_id: examId,
        group_id: groupAId,
        question_order: 1,
        question_type: 'mcq',
        question_text: 'Which organelle contains the hereditary genetic material in eukaryotic cells?',
        options: [
          'Nucleus containing DNA chromatin',
          'Mitochondrial matrix only',
          'Endoplasmic reticulum lumen',
          'Golgi apparatus cisternae',
        ],
        correct_answer: 'Nucleus containing DNA chromatin',
        explanation: 'The nucleus houses the hereditary genetic material in the form of chromatin fibers.',
        marks: 2.0,
        difficulty: 'easy',
        bloom_level: 'remember',
        source_document_name: 'Cell_Biology_101.pdf',
        source_page: 1,
        source_chapter: 'Cell Architecture',
        source_section: '1.1 The Nucleus and Genetic Repository',
        source_chunk_id: 'chunk-cb-1',
        source_evidence:
          'The nucleus is the defining organelle of eukaryotic cells, serving as the repository of hereditary genetic material.',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 'q-a-2',
        exam_id: examId,
        group_id: groupAId,
        question_order: 2,
        question_type: 'true_false',
        question_text: 'True or False: Smooth endoplasmic reticulum is covered with ribosomes for secretory protein translation.',
        options: ['True', 'False'],
        correct_answer: 'False',
        explanation: 'Smooth endoplasmic reticulum lacks ribosomes and specializes in lipid synthesis, not protein translation.',
        marks: 1.0,
        difficulty: 'medium',
        bloom_level: 'understand',
        source_document_name: 'Cell_Biology_101.pdf',
        source_page: 1,
        source_chapter: 'Cell Architecture',
        source_section: '1.2 Ribosomes and Endomembrane System',
        source_chunk_id: 'chunk-cb-2',
        source_evidence:
          'The smooth endoplasmic reticulum lacks ribosomes and specializes in lipid synthesis, carbohydrate metabolism, and calcium sequestration.',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 'q-a-3',
        exam_id: examId,
        group_id: groupAId,
        question_order: 3,
        question_type: 'short_answer',
        question_text: 'Explain why active transport across plasma membranes relies on mitochondrial function.',
        options: null,
        correct_answer:
          'Mitochondria generate ATP via oxidative phosphorylation, and active transport mechanisms (such as the Na+/K+ ATPase pump) require continuous ATP hydrolysis.',
        explanation: 'Active transport requires ATP hydrolysis, which is generated primarily by mitochondria.',
        marks: 3.0,
        difficulty: 'hard',
        bloom_level: 'analyze',
        source_document_name: 'Cell_Biology_101.pdf',
        source_page: 2,
        source_chapter: 'Bioenergetics',
        source_section: '2.1 Mitochondria and ATP Synthesis',
        source_chunk_id: 'chunk-cb-3',
        source_evidence:
          'Active transport mechanisms across plasma membranes, such as the sodium-potassium ATPase pump, rely strictly on continuous ATP hydrolysis.',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const groupBQuestions: QuestionRecord[] = [
      {
        id: 'q-b-1',
        exam_id: examId,
        group_id: groupBId,
        question_order: 1,
        question_type: 'true_false',
        question_text: 'True or False: Smooth endoplasmic reticulum is covered with ribosomes for secretory protein translation.',
        options: ['True', 'False'],
        correct_answer: 'False',
        explanation: 'Smooth endoplasmic reticulum lacks ribosomes and specializes in lipid synthesis.',
        marks: 1.0,
        difficulty: 'medium',
        bloom_level: 'understand',
        source_document_name: 'Cell_Biology_101.pdf',
        source_page: 1,
        source_chapter: 'Cell Architecture',
        source_section: '1.2 Ribosomes and Endomembrane System',
        source_chunk_id: 'chunk-cb-2',
        source_evidence:
          'The smooth endoplasmic reticulum lacks ribosomes and specializes in lipid synthesis, carbohydrate metabolism, and calcium sequestration.',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 'q-b-2',
        exam_id: examId,
        group_id: groupBId,
        question_order: 2,
        question_type: 'mcq',
        question_text: 'Which organelle contains the hereditary genetic material in eukaryotic cells?',
        options: [
          'Endoplasmic reticulum lumen',
          'Nucleus containing DNA chromatin',
          'Golgi apparatus cisternae',
          'Mitochondrial matrix only',
        ],
        correct_answer: 'Nucleus containing DNA chromatin',
        explanation: 'The nucleus houses the hereditary genetic material in the form of chromatin fibers.',
        marks: 2.0,
        difficulty: 'easy',
        bloom_level: 'remember',
        source_document_name: 'Cell_Biology_101.pdf',
        source_page: 1,
        source_chapter: 'Cell Architecture',
        source_section: '1.1 The Nucleus and Genetic Repository',
        source_chunk_id: 'chunk-cb-1',
        source_evidence:
          'The nucleus is the defining organelle of eukaryotic cells, serving as the repository of hereditary genetic material.',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 'q-b-3',
        exam_id: examId,
        group_id: groupBId,
        question_order: 3,
        question_type: 'short_answer',
        question_text: 'Explain why active transport across plasma membranes relies on mitochondrial function.',
        options: null,
        correct_answer:
          'Mitochondria generate ATP via oxidative phosphorylation, and active transport mechanisms (such as the Na+/K+ ATPase pump) require continuous ATP hydrolysis.',
        explanation: 'Active transport requires ATP hydrolysis, which is generated primarily by mitochondria.',
        marks: 3.0,
        difficulty: 'hard',
        bloom_level: 'analyze',
        source_document_name: 'Cell_Biology_101.pdf',
        source_page: 2,
        source_chapter: 'Bioenergetics',
        source_section: '2.1 Mitochondria and ATP Synthesis',
        source_chunk_id: 'chunk-cb-3',
        source_evidence:
          'Active transport mechanisms across plasma membranes, such as the sodium-potassium ATPase pump, rely strictly on continuous ATP hydrolysis.',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const groupCQuestions: QuestionRecord[] = [
      {
        id: 'q-c-1',
        exam_id: examId,
        group_id: groupCId,
        question_order: 1,
        question_type: 'short_answer',
        question_text: 'Explain why active transport across plasma membranes relies on mitochondrial function.',
        options: null,
        correct_answer:
          'Mitochondria generate ATP via oxidative phosphorylation, and active transport mechanisms (such as the Na+/K+ ATPase pump) require continuous ATP hydrolysis.',
        explanation: 'Active transport requires ATP hydrolysis, which is generated primarily by mitochondria.',
        marks: 3.0,
        difficulty: 'hard',
        bloom_level: 'analyze',
        source_document_name: 'Cell_Biology_101.pdf',
        source_page: 2,
        source_chapter: 'Bioenergetics',
        source_section: '2.1 Mitochondria and ATP Synthesis',
        source_chunk_id: 'chunk-cb-3',
        source_evidence:
          'Active transport mechanisms across plasma membranes, such as the sodium-potassium ATPase pump, rely strictly on continuous ATP hydrolysis.',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 'q-c-2',
        exam_id: examId,
        group_id: groupCId,
        question_order: 2,
        question_type: 'mcq',
        question_text: 'Which organelle contains the hereditary genetic material in eukaryotic cells?',
        options: [
          'Golgi apparatus cisternae',
          'Mitochondrial matrix only',
          'Nucleus containing DNA chromatin',
          'Endoplasmic reticulum lumen',
        ],
        correct_answer: 'Nucleus containing DNA chromatin',
        explanation: 'The nucleus houses the hereditary genetic material in the form of chromatin fibers.',
        marks: 2.0,
        difficulty: 'easy',
        bloom_level: 'remember',
        source_document_name: 'Cell_Biology_101.pdf',
        source_page: 1,
        source_chapter: 'Cell Architecture',
        source_section: '1.1 The Nucleus and Genetic Repository',
        source_chunk_id: 'chunk-cb-1',
        source_evidence:
          'The nucleus is the defining organelle of eukaryotic cells, serving as the repository of hereditary genetic material.',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 'q-c-3',
        exam_id: examId,
        group_id: groupCId,
        question_order: 3,
        question_type: 'true_false',
        question_text: 'True or False: Smooth endoplasmic reticulum is covered with ribosomes for secretory protein translation.',
        options: ['True', 'False'],
        correct_answer: 'False',
        explanation: 'Smooth endoplasmic reticulum lacks ribosomes and specializes in lipid synthesis.',
        marks: 1.0,
        difficulty: 'medium',
        bloom_level: 'understand',
        source_document_name: 'Cell_Biology_101.pdf',
        source_page: 1,
        source_chapter: 'Cell Architecture',
        source_section: '1.2 Ribosomes and Endomembrane System',
        source_chunk_id: 'chunk-cb-2',
        source_evidence:
          'The smooth endoplasmic reticulum lacks ribosomes and specializes in lipid synthesis, carbohydrate metabolism, and calcium sequestration.',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const seedExam: ExamRecord = {
      id: examId,
      user_id: null,
      session_id: 'default',
      document_id: seedDocId,
      title: 'Cell Biology Midterm Examination',
      subject: 'Molecular & Cellular Biology',
      institution: 'Faculty of Sciences',
      teacher_name: 'Prof. Harrison',
      grade_level: 'Undergraduate Year 2',
      duration_minutes: 60,
      total_marks: 6.0,
      language: 'en',
      is_rtl: false,
      bloom_enabled: true,
      status: 'ready',
      groups_count: 3,
      questions_count: 9,
      difficulty_distribution: { easy: 40, medium: 40, hard: 20 },
      question_types_config: { mcq: 1, true_false: 1, short_answer: 1 },
      groups: [
        {
          id: groupAId,
          exam_id: examId,
          group_name: 'Group A',
          group_order: 1,
          questions_count: 3,
          questions: groupAQuestions,
        },
        {
          id: groupBId,
          exam_id: examId,
          group_name: 'Group B',
          group_order: 2,
          questions_count: 3,
          questions: groupBQuestions,
        },
        {
          id: groupCId,
          exam_id: examId,
          group_name: 'Group C',
          group_order: 3,
          questions_count: 3,
          questions: groupCQuestions,
        },
      ],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    this.insertExam(seedExam);
  }

  // --- USER METHODS ---
  public createUser(user: Omit<UserRecord, 'token_version'>): UserRecord {
    const stmt = this.db.prepare(`
      INSERT INTO users (id, email, password_hash, salt, full_name, institution, role, token_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);
    stmt.run(
      user.id,
      user.email,
      user.password_hash,
      user.salt,
      user.full_name,
      user.institution,
      user.role,
      user.created_at,
      user.updated_at
    );
    return { ...user, token_version: 1 };
  }

  public getUserByEmail(email: string): UserRecord | null {
    const stmt = this.db.prepare('SELECT * FROM users WHERE email = ?');
    const row = stmt.get(email.toLowerCase().trim()) as any;
    return row || null;
  }

  public getUserById(id: string): UserRecord | null {
    const stmt = this.db.prepare('SELECT * FROM users WHERE id = ?');
    const row = stmt.get(id) as any;
    return row || null;
  }

  public bumpTokenVersion(userId: string): number {
    const stmt = this.db.prepare(`
      UPDATE users SET token_version = token_version + 1, updated_at = ? WHERE id = ?
    `);
    stmt.run(new Date().toISOString(), userId);
    const updated = this.getUserById(userId);
    return updated ? updated.token_version : 1;
  }

  // --- DOCUMENT METHODS ---
  public insertDocument(doc: DocumentRecord): void {
    const docStmt = this.db.prepare(`
      INSERT INTO documents (
        id, user_id, session_id, filename, file_type, file_size_bytes,
        detected_language, is_rtl, total_pages, status, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    docStmt.run(
      doc.id,
      doc.user_id || null,
      doc.session_id || null,
      doc.filename,
      doc.file_type,
      doc.file_size_bytes,
      doc.detected_language,
      doc.is_rtl ? 1 : 0,
      doc.total_pages,
      doc.status,
      JSON.stringify(doc.metadata || {}),
      doc.created_at
    );

    if (doc.chunks && doc.chunks.length > 0) {
      const chunkStmt = this.db.prepare(`
        INSERT INTO document_chunks (
          id, document_id, page_number, chapter, section, content, token_count, chunk_index
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const chunk of doc.chunks) {
        chunkStmt.run(
          chunk.id,
          doc.id,
          chunk.page_number,
          chunk.chapter || null,
          chunk.section || null,
          chunk.content,
          chunk.token_count || 0,
          chunk.chunk_index || 0
        );
      }
    }
  }

  public getDocumentById(id: string): DocumentRecord | null {
    const docStmt = this.db.prepare('SELECT * FROM documents WHERE id = ?');
    const row = docStmt.get(id) as any;
    if (!row) return null;

    const chunkStmt = this.db.prepare(
      'SELECT * FROM document_chunks WHERE document_id = ? ORDER BY chunk_index ASC'
    );
    const chunks = (chunkStmt.all(id) as any[]).map((c) => ({
      id: c.id,
      document_id: c.document_id,
      page_number: c.page_number,
      chapter: c.chapter,
      section: c.section,
      content: c.content,
      token_count: c.token_count,
      chunk_index: c.chunk_index,
    }));

    return {
      id: row.id,
      user_id: row.user_id,
      session_id: row.session_id,
      filename: row.filename,
      file_type: row.file_type,
      file_size_bytes: row.file_size_bytes,
      detected_language: row.detected_language,
      is_rtl: Boolean(row.is_rtl),
      total_pages: row.total_pages,
      status: row.status,
      metadata: JSON.parse(row.metadata_json || '{}'),
      chunks,
      created_at: row.created_at,
    };
  }

  public getDocumentsByOwner(userId?: string | null, sessionId?: string | null): DocumentRecord[] {
    let stmt;
    let rows: any[];
    if (userId) {
      stmt = this.db.prepare(
        "SELECT * FROM documents WHERE user_id = ? OR (user_id IS NULL AND session_id = 'default') ORDER BY created_at DESC"
      );
      rows = stmt.all(userId) as any[];
    } else if (sessionId) {
      stmt = this.db.prepare(
        "SELECT * FROM documents WHERE session_id = ? OR session_id = 'default' ORDER BY created_at DESC"
      );
      rows = stmt.all(sessionId) as any[];
    } else {
      stmt = this.db.prepare("SELECT * FROM documents WHERE session_id = 'default' ORDER BY created_at DESC");
      rows = stmt.all() as any[];
    }

    const chunkStmt = this.db.prepare(
      'SELECT * FROM document_chunks WHERE document_id = ? ORDER BY chunk_index ASC'
    );

    return rows.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      session_id: row.session_id,
      filename: row.filename,
      file_type: row.file_type,
      file_size_bytes: row.file_size_bytes,
      detected_language: row.detected_language,
      is_rtl: Boolean(row.is_rtl),
      total_pages: row.total_pages,
      status: row.status,
      metadata: JSON.parse(row.metadata_json || '{}'),
      chunks: (chunkStmt.all(row.id) as any[]).map((c) => ({
        id: c.id,
        document_id: c.document_id,
        page_number: c.page_number,
        chapter: c.chapter,
        section: c.section,
        content: c.content,
        token_count: c.token_count,
        chunk_index: c.chunk_index,
      })),
      created_at: row.created_at,
    }));
  }

  public deleteDocument(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM documents WHERE id = ?');
    stmt.run(id);
    return true;
  }

  // --- EXAM METHODS ---
  public insertExam(exam: ExamRecord): void {
    const examStmt = this.db.prepare(`
      INSERT INTO exams (
        id, user_id, session_id, document_id, title, subject, institution, faculty,
        teacher_name, grade_level, exam_date, duration_minutes, total_marks,
        language, is_rtl, bloom_enabled, status, groups_count, questions_count,
        difficulty_distribution_json, question_types_config_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    examStmt.run(
      exam.id,
      exam.user_id || null,
      exam.session_id || null,
      exam.document_id || null,
      exam.title,
      exam.subject,
      exam.institution || null,
      exam.faculty || null,
      exam.teacher_name || null,
      exam.grade_level || null,
      exam.exam_date || null,
      exam.duration_minutes,
      exam.total_marks,
      exam.language,
      exam.is_rtl ? 1 : 0,
      exam.bloom_enabled ? 1 : 0,
      exam.status,
      exam.groups_count,
      exam.questions_count,
      JSON.stringify(exam.difficulty_distribution || {}),
      JSON.stringify(exam.question_types_config || {}),
      exam.created_at,
      exam.updated_at
    );

    const groupStmt = this.db.prepare(`
      INSERT INTO exam_groups (id, exam_id, group_name, group_order, questions_count)
      VALUES (?, ?, ?, ?, ?)
    `);

    const qStmt = this.db.prepare(`
      INSERT INTO exam_questions (
        id, exam_id, group_id, question_order, question_type, question_text,
        options_json, correct_answer, explanation, marks, difficulty, bloom_level,
        source_document_name, source_page, source_chapter, source_section,
        source_chunk_id, source_evidence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const group of exam.groups) {
      groupStmt.run(group.id, exam.id, group.group_name, group.group_order, group.questions_count);
      for (const q of group.questions) {
        qStmt.run(
          q.id,
          exam.id,
          group.id,
          q.question_order,
          q.question_type,
          q.question_text,
          q.options ? JSON.stringify(q.options) : null,
          q.correct_answer,
          q.explanation || null,
          q.marks,
          q.difficulty,
          q.bloom_level,
          q.source_document_name,
          q.source_page,
          q.source_chapter || null,
          q.source_section || null,
          q.source_chunk_id || null,
          q.source_evidence,
          q.created_at,
          q.updated_at
        );
      }
    }
  }

  public getExamById(id: string): ExamRecord | null {
    const examStmt = this.db.prepare('SELECT * FROM exams WHERE id = ?');
    const row = examStmt.get(id) as any;
    if (!row) return null;

    const groupStmt = this.db.prepare(
      'SELECT * FROM exam_groups WHERE exam_id = ? ORDER BY group_order ASC'
    );
    const groupRows = groupStmt.all(id) as any[];

    const qStmt = this.db.prepare(
      'SELECT * FROM exam_questions WHERE group_id = ? ORDER BY question_order ASC'
    );

    const groups: ExamGroupRecord[] = groupRows.map((gRow) => {
      const qRows = qStmt.all(gRow.id) as any[];
      const questions: QuestionRecord[] = qRows.map((q) => ({
        id: q.id,
        exam_id: q.exam_id,
        group_id: q.group_id,
        question_order: q.question_order,
        question_type: q.question_type,
        question_text: q.question_text,
        options: q.options_json ? JSON.parse(q.options_json) : null,
        correct_answer: q.correct_answer,
        explanation: q.explanation || '',
        marks: q.marks,
        difficulty: q.difficulty,
        bloom_level: q.bloom_level,
        source_document_name: q.source_document_name,
        source_page: q.source_page,
        source_chapter: q.source_chapter,
        source_section: q.source_section,
        source_chunk_id: q.source_chunk_id,
        source_evidence: q.source_evidence,
        created_at: q.created_at,
        updated_at: q.updated_at,
      }));

      return {
        id: gRow.id,
        exam_id: gRow.exam_id,
        group_name: gRow.group_name,
        group_order: gRow.group_order,
        questions_count: questions.length,
        questions,
      };
    });

    return {
      id: row.id,
      user_id: row.user_id,
      session_id: row.session_id,
      document_id: row.document_id,
      title: row.title,
      subject: row.subject,
      institution: row.institution || null,
      faculty: row.faculty || null,
      teacher_name: row.teacher_name,
      grade_level: row.grade_level,
      exam_date: row.exam_date,
      duration_minutes: row.duration_minutes,
      total_marks: row.total_marks,
      language: row.language,
      is_rtl: Boolean(row.is_rtl),
      bloom_enabled: Boolean(row.bloom_enabled),
      status: row.status,
      groups_count: groups.length,
      questions_count: groups.reduce((acc, g) => acc + g.questions.length, 0),
      difficulty_distribution: JSON.parse(row.difficulty_distribution_json || '{}'),
      question_types_config: JSON.parse(row.question_types_config_json || '{}'),
      groups,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  public getExamsByOwner(userId?: string | null, sessionId?: string | null): ExamRecord[] {
    let stmt;
    let rows: any[];
    if (userId) {
      stmt = this.db.prepare(
        "SELECT id FROM exams WHERE user_id = ? OR (user_id IS NULL AND session_id = 'default') ORDER BY created_at DESC"
      );
      rows = stmt.all(userId) as any[];
    } else if (sessionId) {
      stmt = this.db.prepare(
        "SELECT id FROM exams WHERE session_id = ? OR session_id = 'default' ORDER BY created_at DESC"
      );
      rows = stmt.all(sessionId) as any[];
    } else {
      stmt = this.db.prepare("SELECT id FROM exams WHERE session_id = 'default' ORDER BY created_at DESC");
      rows = stmt.all() as any[];
    }

    const exams: ExamRecord[] = [];
    for (const row of rows) {
      const exam = this.getExamById(row.id);
      if (exam) exams.push(exam);
    }
    return exams;
  }

  public deleteExam(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM exams WHERE id = ?');
    stmt.run(id);
    return true;
  }

  public updateExamMetadata(
    examId: string,
    updates: {
      title?: string;
      subject?: string;
      institution?: string | null;
      faculty?: string | null;
      teacher_name?: string | null;
      grade_level?: string | null;
      exam_date?: string | null;
      duration_minutes?: number;
      total_marks?: number;
      questions_count?: number;
    }
  ): ExamRecord | null {
    const existing = this.getExamById(examId);
    if (!existing) return null;

    const sets: string[] = ['updated_at = ?'];
    const params: any[] = [new Date().toISOString()];

    if (updates.title !== undefined) {
      sets.push('title = ?');
      params.push(updates.title);
    }
    if (updates.subject !== undefined) {
      sets.push('subject = ?');
      params.push(updates.subject);
    }
    if (updates.institution !== undefined) {
      sets.push('institution = ?');
      params.push(updates.institution);
    }
    if (updates.faculty !== undefined) {
      sets.push('faculty = ?');
      params.push(updates.faculty);
    }
    if (updates.teacher_name !== undefined) {
      sets.push('teacher_name = ?');
      params.push(updates.teacher_name);
    }
    if (updates.grade_level !== undefined) {
      sets.push('grade_level = ?');
      params.push(updates.grade_level);
    }
    if (updates.exam_date !== undefined) {
      sets.push('exam_date = ?');
      params.push(updates.exam_date);
    }
    if (updates.duration_minutes !== undefined) {
      sets.push('duration_minutes = ?');
      params.push(updates.duration_minutes);
    }
    if (updates.total_marks !== undefined) {
      sets.push('total_marks = ?');
      params.push(updates.total_marks);
    }
    if (updates.questions_count !== undefined) {
      sets.push('questions_count = ?');
      params.push(updates.questions_count);
    }

    params.push(examId);
    this.db.prepare(`UPDATE exams SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.getExamById(examId);
  }

  public updateQuestion(
    questionId: string,
    updates: {
      question_text?: string;
      marks?: number;
      options?: string[] | null;
      correct_answer?: string;
      explanation?: string | null;
    }
  ): boolean {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.question_text !== undefined) {
      fields.push('question_text = ?');
      values.push(updates.question_text);
    }
    if (updates.marks !== undefined) {
      fields.push('marks = ?');
      values.push(updates.marks);
    }
    if (updates.options !== undefined) {
      fields.push('options_json = ?');
      values.push(updates.options ? JSON.stringify(updates.options) : null);
    }
    if (updates.correct_answer !== undefined) {
      fields.push('correct_answer = ?');
      values.push(updates.correct_answer);
    }
    if (updates.explanation !== undefined) {
      fields.push('explanation = ?');
      values.push(updates.explanation);
    }

    if (fields.length === 0) return true;

    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(questionId);

    const sql = `UPDATE exam_questions SET ${fields.join(', ')} WHERE id = ?`;
    const stmt = this.db.prepare(sql);
    stmt.run(...values);
    return true;
  }

  public deleteQuestion(questionId: string): boolean {
    const stmt = this.db.prepare('DELETE FROM exam_questions WHERE id = ?');
    stmt.run(questionId);
    return true;
  }

  public updateGroupQuestionsCount(groupId: string, count: number): void {
    const stmt = this.db.prepare('UPDATE exam_groups SET questions_count = ? WHERE id = ?');
    stmt.run(count, groupId);
  }

  public updateQuestionOrder(questionId: string, order: number): void {
    const stmt = this.db.prepare('UPDATE exam_questions SET question_order = ?, updated_at = ? WHERE id = ?');
    stmt.run(order, new Date().toISOString(), questionId);
  }

  // Explicit Guest Data Transfer with User Consent
  public transferGuestDataToUser(sessionId: string, userId: string): { transferredDocuments: number; transferredExams: number } {
    if (!sessionId || !userId || sessionId === 'default') {
      return { transferredDocuments: 0, transferredExams: 0 };
    }

    const docUpdateStmt = this.db.prepare(`
      UPDATE documents SET user_id = ?, session_id = NULL WHERE session_id = ?
    `);
    const docRes = docUpdateStmt.run(userId, sessionId) as any;

    const examUpdateStmt = this.db.prepare(`
      UPDATE exams SET user_id = ?, session_id = NULL WHERE session_id = ?
    `);
    const examRes = examUpdateStmt.run(userId, sessionId) as any;

    return {
      transferredDocuments: docRes.changes || 0,
      transferredExams: examRes.changes || 0,
    };
  }
}

export const db = new ExamCraftDatabase();
