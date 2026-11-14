import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import type { 
  SubscriptionPackage, 
  ExamDateConfig, 
  UserSubscription, 
  PaymentRequest, 
  StudentSession, 
  AuditLog, 
  ExamResult, 
  ExamAttempt,
  Subject,
  Question,
  Exam
} from './src/types/index.ts';
import { INITIAL_PACKAGES, INITIAL_EXAM_DATE_CONFIG } from './src/data/initialPackages.ts';
import { INITIAL_SUBJECTS, INITIAL_QUESTIONS } from './src/data/mockData.ts';
import { INITIAL_EXAMS } from './src/data/initialExams.ts';
import { calculateExamScore } from './src/utils/scoring.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In-Memory Database with optional disk persistence
interface ServerDB {
  packages: SubscriptionPackage[];
  examDateConfig: ExamDateConfig;
  paymentSettings: {
    bkashNumber: string;
    nagadNumber: string;
    packagePrice: number;
    whatsappNumber: string;
    whatsappMessage: string;
  };
  supportSettings: {
    whatsappNumber: string;
    whatsappMessage: string;
  };
  paymentRequests: PaymentRequest[];
  subscriptions: UserSubscription[];
  subjects: Subject[];
  questions: Question[];
  exams: Exam[];
  sessions: Record<string, StudentSession>; // sessionId -> Session
  userActiveSessions: Record<string, string>; // userId -> active sessionId
  examAttempts: Record<string, ExamAttempt>;
  examResults: ExamResult[];
  auditLogs: AuditLog[];
}

const db: ServerDB = {
  packages: [...INITIAL_PACKAGES],
  examDateConfig: { ...INITIAL_EXAM_DATE_CONFIG },
  subjects: [...INITIAL_SUBJECTS],
  questions: [...INITIAL_QUESTIONS],
  exams: [...INITIAL_EXAMS],
  paymentSettings: {
    bkashNumber: '01712607777',
    nagadNumber: '01712607777',
    packagePrice: 300,
    whatsappNumber: '+8801671819027',
    whatsappMessage: 'Hello Sanad Prep BD Support, I need help with my account or subscription.'
  },
  supportSettings: {
    whatsappNumber: '+8801671819027',
    whatsappMessage: 'Hello Sanad Prep BD Support, I need help with my account or subscription.'
  },
  paymentRequests: [
    {
      id: 'pay_seed_1',
      userId: 'user_candidate_786',
      studentName: 'মো: খাইরুল আলম',
      studentPhone: '01712-345678',
      method: 'bKash',
      senderNumber: '01712607777',
      transactionId: '9K28DF10PQ',
      amount: 300,
      packageId: 'pkg_pro_mock',
      packageNameBn: 'প্রো মডেল টেস্ট পাস (Pro Model Test Pass)',
      packageNameEn: 'Pro Model Test Pass',
      packageTitle: 'Sanad Prep BD প্রো মডেল টেস্ট পাস (৯০ দিন)',
      durationDays: 90,
      validityType: 'days',
      status: 'pending',
      requestedAt: new Date(Date.now() - 3600000).toISOString()
    }
  ],
  subscriptions: [],
  sessions: {},
  userActiveSessions: {},
  examAttempts: {},
  examResults: [],
  auditLogs: [
    {
      id: 'log_boot',
      userId: 'admin_sys',
      userName: 'Sanad Prep BD System',
      action: 'SERVER_BOOT',
      details: 'Sanad Prep BD Full-Stack Production Subscription Engine initialized.',
      timestamp: new Date().toISOString()
    }
  ]
};

// Helper to calculate exact expiry for packages
export function calculateSubscriptionExpiry(
  validityType: 'days' | 'exam_date',
  durationDays?: number,
  targetExamDate?: string
): string {
  if (validityType === 'days') {
    const days = durationDays || 90;
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }
  // For exam_date, use targetExamDate
  if (targetExamDate) {
    const d = new Date(targetExamDate);
    // If invalid date, fallback to 90 days
    if (!isNaN(d.getTime())) {
      return d.toISOString();
    }
  }
  return new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
}

// Session Validation Middleware
function authenticateSession(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }
  const token = authHeader.substring(7).trim();
  const session = db.sessions[token];
  if (!session) {
    return res.status(401).json({ error: 'SESSION_INVALID', message: 'Session not found. Please log in again.' });
  }
  if (session.status === 'revoked') {
    return res.status(401).json({ 
      error: 'SESSION_REVOKED', 
      message: 'একই অ্যাকাউন্ট অন্য ডিভাইস থেকে লগইন করা হয়েছে। আপনার পূর্ববর্তী সেশনটি বন্ধ করা হয়েছে। (Session revoked due to concurrent login)' 
    });
  }
  // Check if current active session for this user matches
  const currentActive = db.userActiveSessions[session.userId];
  if (currentActive && currentActive !== token) {
    session.status = 'revoked';
    session.revokedReason = 'Logged in from another device/browser';
    return res.status(401).json({ 
      error: 'SESSION_REVOKED', 
      message: 'Multi-device account sharing protection: Session revoked.' 
    });
  }
  session.lastActiveAt = new Date().toISOString();
  (req as any).session = session;
  next();
}

async function startServer() {
  const app = express();
  app.use(express.json());

  // Log API requests
  app.use('/api', (req, res, next) => {
    next();
  });

  // Health
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'Sanad Prep BD Subscription & Examination Engine',
      serverTime: new Date().toISOString(),
      timezone: db.examDateConfig.timezone
    });
  });

  // 1. Packages API
  app.get('/api/packages', (req, res) => {
    const active = db.packages.filter(p => p.isActive && !p.isArchived);
    // Sync Exam Pass price with examDateConfig
    const mapped = active.map(p => {
      if (p.id === 'pkg_exam_pass') {
        return { ...p, price: db.examDateConfig.examPassPrice };
      }
      return p;
    });
    res.json({ packages: mapped });
  });

  // Admin Packages
  app.get('/api/admin/packages', (req, res) => {
    res.json({ packages: db.packages, examDateConfig: db.examDateConfig });
  });

  app.post('/api/admin/packages/update', (req, res) => {
    const { id, price, durationDays, isActive } = req.body;
    const pkg = db.packages.find(p => p.id === id);
    if (!pkg) {
      return res.status(404).json({ error: 'Package not found' });
    }
    if (price !== undefined) pkg.price = Number(price);
    if (durationDays !== undefined) pkg.durationDays = Number(durationDays);
    if (isActive !== undefined) pkg.isActive = Boolean(isActive);
    pkg.updatedAt = new Date().toISOString();

    db.auditLogs.unshift({
      id: `log_${Date.now()}`,
      userId: 'admin_action',
      userName: 'Administrator',
      action: 'UPDATE_PACKAGE',
      details: `Updated package ${pkg.nameEn}: Price=${pkg.price}, Duration=${pkg.durationDays}d, Active=${pkg.isActive}`,
      timestamp: new Date().toISOString()
    });

    res.json({ success: true, package: pkg });
  });

  // 2. Exam Date Config API
  app.get('/api/exam-config', (req, res) => {
    res.json({ examDateConfig: db.examDateConfig });
  });

  app.post('/api/admin/exam-config', (req, res) => {
    const { targetExamDate, examDatePolicy, examPassPrice, examTitleBn, examTitleEn } = req.body;
    
    if (targetExamDate) db.examDateConfig.targetExamDate = targetExamDate;
    if (examDatePolicy) db.examDateConfig.examDatePolicy = examDatePolicy;
    if (examPassPrice !== undefined) {
      db.examDateConfig.examPassPrice = Number(examPassPrice);
      // also update the package in db.packages
      const epPkg = db.packages.find(p => p.id === 'pkg_exam_pass');
      if (epPkg) epPkg.price = Number(examPassPrice);
    }
    if (examTitleBn) db.examDateConfig.examTitleBn = examTitleBn;
    if (examTitleEn) db.examDateConfig.examTitleEn = examTitleEn;
    db.examDateConfig.lastUpdated = new Date().toISOString();

    let affectedSubscribers = 0;
    // Policy rule: If 'extend_all', update expiry date for all existing active Exam Pass subscribers
    if (db.examDateConfig.examDatePolicy === 'extend_all' && targetExamDate) {
      db.subscriptions.forEach(sub => {
        if (sub.packageId === 'pkg_exam_pass' && sub.status === 'active') {
          sub.expiresAt = new Date(targetExamDate).toISOString();
          sub.targetExamDateSnapshot = targetExamDate;
          affectedSubscribers++;
        }
      });
    }

    db.auditLogs.unshift({
      id: `log_${Date.now()}`,
      userId: 'admin_action',
      userName: 'Administrator',
      action: 'UPDATE_EXAM_DATE_CONFIG',
      details: `Target Exam Date set to ${targetExamDate} (${db.examDateConfig.timezone}). Policy: ${db.examDateConfig.examDatePolicy}. Exam Pass Price: ৳${db.examDateConfig.examPassPrice}. Affected active subscribers: ${affectedSubscribers}`,
      timestamp: new Date().toISOString()
    });

    res.json({
      success: true,
      examDateConfig: db.examDateConfig,
      affectedSubscribers
    });
  });

  // 3. Payment & Support Settings (bKash & Nagad numbers, WhatsApp Support)
  app.get('/api/payment-settings', (req, res) => {
    res.json({ 
      paymentSettings: db.paymentSettings,
      supportSettings: db.supportSettings
    });
  });

  app.get('/api/support-settings', (req, res) => {
    res.json({ supportSettings: db.supportSettings });
  });

  app.post('/api/admin/payment-settings', (req, res) => {
    const { bkashNumber, nagadNumber, whatsappNumber, whatsappMessage } = req.body;
    if (bkashNumber) db.paymentSettings.bkashNumber = bkashNumber.trim();
    if (nagadNumber) db.paymentSettings.nagadNumber = nagadNumber.trim();
    if (whatsappNumber) {
      db.paymentSettings.whatsappNumber = whatsappNumber.trim();
      db.supportSettings.whatsappNumber = whatsappNumber.trim();
    }
    if (whatsappMessage) {
      db.paymentSettings.whatsappMessage = whatsappMessage.trim();
      db.supportSettings.whatsappMessage = whatsappMessage.trim();
    }

    db.auditLogs.unshift({
      id: `log_${Date.now()}`,
      userId: 'admin_action',
      userName: 'Administrator',
      action: 'UPDATE_SETTINGS',
      details: `Updated Numbers: bKash: ${db.paymentSettings.bkashNumber}, Nagad: ${db.paymentSettings.nagadNumber}, WhatsApp: ${db.supportSettings.whatsappNumber}`,
      timestamp: new Date().toISOString()
    });

    res.json({ 
      success: true, 
      paymentSettings: db.paymentSettings,
      supportSettings: db.supportSettings
    });
  });

  app.post('/api/admin/support-settings', (req, res) => {
    const { whatsappNumber, whatsappMessage } = req.body;
    if (whatsappNumber) {
      db.supportSettings.whatsappNumber = whatsappNumber.trim();
      db.paymentSettings.whatsappNumber = whatsappNumber.trim();
    }
    if (whatsappMessage) {
      db.supportSettings.whatsappMessage = whatsappMessage.trim();
      db.paymentSettings.whatsappMessage = whatsappMessage.trim();
    }

    db.auditLogs.unshift({
      id: `log_${Date.now()}`,
      userId: 'admin_action',
      userName: 'Administrator',
      action: 'UPDATE_SUPPORT_CONTACT',
      details: `Updated WhatsApp Support: ${db.supportSettings.whatsappNumber}`,
      timestamp: new Date().toISOString()
    });

    res.json({ success: true, supportSettings: db.supportSettings });
  });

  // 4. Session & Single-Active-Session Protection
  app.post('/api/auth/session', (req, res) => {
    const { userId, userEmail, userName, deviceInfo } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    // REVOKE PREVIOUS ACTIVE SESSION FOR THIS USER
    const previousSessionId = db.userActiveSessions[userId];
    if (previousSessionId && db.sessions[previousSessionId]) {
      db.sessions[previousSessionId].status = 'revoked';
      db.sessions[previousSessionId].revokedReason = 'Logged in from another device or tab (Single active session enforcement)';
      
      db.auditLogs.unshift({
        id: `log_${Date.now()}`,
        userId,
        userName: userName || 'Student',
        action: 'SESSION_REVOKED_CONCURRENT',
        details: `Previous session ${previousSessionId.substring(0, 8)}... revoked due to new login.`,
        timestamp: new Date().toISOString()
      });
    }

    // Create new session
    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const newSession: StudentSession = {
      sessionId,
      userId,
      userEmail: userEmail || '',
      userName: userName || 'Student',
      deviceInfo: deviceInfo || req.headers['user-agent'] || 'Web Browser',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active'
    };

    db.sessions[sessionId] = newSession;
    db.userActiveSessions[userId] = sessionId;

    // Check active subscription
    const activeSub = db.subscriptions.find(
      s => s.userId === userId && s.status === 'active' && new Date(s.expiresAt).getTime() > Date.now()
    );

    res.json({
      success: true,
      sessionId,
      session: newSession,
      activeSubscription: activeSub || null
    });
  });

  app.get('/api/auth/session/status', authenticateSession, (req, res) => {
    const session = (req as any).session;
    if (!session) {
      return res.status(401).json({ active: false });
    }
    const activeSub = db.subscriptions.find(
      s => s.userId === session.userId && s.status === 'active' && new Date(s.expiresAt).getTime() > Date.now()
    );
    res.json({
      active: true,
      session,
      activeSubscription: activeSub || null
    });
  });

  // 5. Payment Requests (Student Submission & Admin Verification)
  app.post('/api/payments/create', authenticateSession, (req, res) => {
    const session = (req as any).session;
    const { 
      method, 
      senderNumber, 
      transactionId, 
      amount, 
      packageId, 
      studentPhone 
    } = req.body;

    if (!method || !senderNumber || !transactionId || !packageId) {
      return res.status(400).json({ error: 'Missing required payment fields' });
    }

    const cleanTrxId = transactionId.trim().toUpperCase();

    // Prevent duplicate pending TrxID reuse
    const existing = db.paymentRequests.find(
      p => p.transactionId === cleanTrxId && p.status !== 'rejected'
    );
    if (existing) {
      return res.status(409).json({ 
        error: 'DUPLICATE_TRX_ID', 
        message: 'এই ট্রানজাকশন আইডিটি (TrxID) ইতিপূর্বে ব্যবহার করা হয়েছে বা অপেক্ষমান রয়েছে। (Transaction ID already submitted)' 
      });
    }

    // Find requested package
    const pkg = db.packages.find(p => p.id === packageId) || db.packages[0];
    const durationDays = pkg.durationDays || 90;
    const validityType = pkg.validityType || 'days';

    const newReq: PaymentRequest = {
      id: `pay_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      userId: session ? session.userId : (req.body.userId || 'user_candidate_786'),
      studentName: session ? session.userName : (req.body.studentName || 'Student'),
      studentPhone: studentPhone || senderNumber,
      method,
      senderNumber,
      transactionId: cleanTrxId,
      amount: Number(amount) || pkg.price,
      packageId: pkg.id,
      packageNameBn: pkg.nameBn,
      packageNameEn: pkg.nameEn,
      packageTitle: `${pkg.nameBn} - ৳${pkg.price}`,
      durationDays,
      validityType,
      status: 'pending',
      requestedAt: new Date().toISOString()
    };

    db.paymentRequests.unshift(newReq);

    db.auditLogs.unshift({
      id: `log_${Date.now()}`,
      userId: newReq.userId,
      userName: newReq.studentName,
      action: 'PAYMENT_SUBMITTED',
      details: `${method} TrxID: ${cleanTrxId} (৳${newReq.amount}) for package "${pkg.nameEn}". Pending manual admin review.`,
      timestamp: new Date().toISOString()
    });

    res.json({
      success: true,
      message: 'পেমেন্ট রিকোয়েস্ট সফলভাবে জমা হয়েছে। অ্যাডমিন ম্যানুয়ালি যাচাই করার পর এক্সেস চালু হবে।',
      paymentRequest: newReq
    });
  });

  app.get('/api/payments', (req, res) => {
    res.json({ paymentRequests: db.paymentRequests });
  });

  // Admin Manual Payment Approval
  app.post('/api/admin/payments/:id/approve', (req, res) => {
    const { id } = req.params;
    const { verifierName } = req.body;
    const reqItem = db.paymentRequests.find(p => p.id === id);

    if (!reqItem) {
      return res.status(404).json({ error: 'Payment request not found' });
    }

    if (reqItem.status === 'approved') {
      return res.status(400).json({ error: 'Payment already approved' });
    }

    // Check if TrxID was already used in another approved request
    const duplicateApproved = db.paymentRequests.find(
      p => p.id !== id && p.transactionId === reqItem.transactionId && p.status === 'approved'
    );
    if (duplicateApproved) {
      return res.status(409).json({ 
        error: 'TRX_ALREADY_APPROVED', 
        message: 'এই TrxID দিয়ে ইতিপূর্বে আরেকটি পেমেন্ট অনুমোদন করা হয়েছে! একই TrxID পুনরাবৃত্তি রোধ করা হলো।' 
      });
    }

    const pkg = db.packages.find(p => p.id === reqItem.packageId) || {
      id: reqItem.packageId,
      nameBn: reqItem.packageNameBn,
      nameEn: reqItem.packageNameEn,
      validityType: reqItem.validityType || 'days',
      durationDays: reqItem.durationDays || 90
    };

    // Calculate exact expiry
    const activatedAt = new Date().toISOString();
    const expiresAt = calculateSubscriptionExpiry(
      pkg.validityType,
      pkg.durationDays,
      db.examDateConfig.targetExamDate
    );

    // Create Subscription
    const newSubscription: UserSubscription = {
      id: `sub_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      userId: reqItem.userId,
      studentName: reqItem.studentName,
      studentPhone: reqItem.studentPhone,
      packageId: reqItem.packageId,
      packageNameBn: reqItem.packageNameBn,
      packageNameEn: reqItem.packageNameEn,
      pricePaid: reqItem.amount,
      paymentRequestId: reqItem.id,
      paymentMethod: reqItem.method as 'bKash' | 'Nagad',
      transactionId: reqItem.transactionId,
      activatedAt,
      expiresAt,
      validityType: pkg.validityType,
      status: 'active',
      targetExamDateSnapshot: pkg.validityType === 'exam_date' ? db.examDateConfig.targetExamDate : undefined,
      createdAt: activatedAt
    };

    db.subscriptions.unshift(newSubscription);

    // Update payment request
    reqItem.status = 'approved';
    reqItem.verifiedAt = activatedAt;
    reqItem.verifiedBy = verifierName || 'Sanad Prep BD Admin';
    reqItem.subscriptionId = newSubscription.id;

    db.auditLogs.unshift({
      id: `log_${Date.now()}`,
      userId: 'admin',
      userName: reqItem.verifiedBy || 'Sanad Prep BD Admin',
      action: 'PAYMENT_APPROVED',
      details: `Approved ${reqItem.method} TrxID: ${reqItem.transactionId} (৳${reqItem.amount}). Activated "${pkg.nameEn}" until ${new Date(expiresAt).toLocaleDateString()}.`,
      timestamp: new Date().toISOString()
    });

    res.json({
      success: true,
      paymentRequest: reqItem,
      subscription: newSubscription
    });
  });

  // Admin Manual Payment Rejection
  app.post('/api/admin/payments/:id/reject', (req, res) => {
    const { id } = req.params;
    const { reason, verifierName } = req.body;
    const reqItem = db.paymentRequests.find(p => p.id === id);

    if (!reqItem) {
      return res.status(404).json({ error: 'Payment request not found' });
    }

    reqItem.status = 'rejected';
    reqItem.rejectionReason = reason || 'Unverified Transaction ID or Amount Mismatch';
    reqItem.verifiedAt = new Date().toISOString();
    reqItem.verifiedBy = verifierName || 'Sanad Prep BD Admin';

    db.auditLogs.unshift({
      id: `log_${Date.now()}`,
      userId: 'admin',
      userName: reqItem.verifiedBy || 'Sanad Prep BD Admin',
      action: 'PAYMENT_REJECTED',
      details: `Rejected ${reqItem.method} TrxID: ${reqItem.transactionId}. Reason: ${reqItem.rejectionReason}`,
      timestamp: new Date().toISOString()
    });

    res.json({
      success: true,
      paymentRequest: reqItem
    });
  });

  // 6. Subscriptions List & Expiry Checks
  app.get('/api/admin/subscriptions', (req, res) => {
    const now = Date.now();
    // Update any expired subscriptions
    const mapped = db.subscriptions.map(s => {
      const isExpired = new Date(s.expiresAt).getTime() <= now;
      const daysRemaining = Math.max(0, Math.ceil((new Date(s.expiresAt).getTime() - now) / (1000 * 60 * 60 * 24)));
      return {
        ...s,
        status: isExpired ? 'expired' : s.status,
        daysRemaining
      };
    });
    res.json({ subscriptions: mapped });
  });

  app.get('/api/subscriptions/active/:userId', (req, res) => {
    const { userId } = req.params;
    const now = Date.now();
    const activeSub = db.subscriptions.find(
      s => s.userId === userId && s.status === 'active' && new Date(s.expiresAt).getTime() > now
    );

    if (!activeSub) {
      return res.json({
        hasActiveSubscription: false,
        status: 'free',
        activeSubscription: null
      });
    }

    const daysRemaining = Math.ceil((new Date(activeSub.expiresAt).getTime() - now) / (1000 * 60 * 60 * 24));
    res.json({
      hasActiveSubscription: true,
      status: 'pro',
      activeSubscription: activeSub,
      daysRemaining
    });
  });

  // 6.5. Admin Dashboard Statistics & Monthly Revenue Report (Requirement 5)
  app.get('/api/admin/dashboard-stats', (req, res) => {
    const now = Date.now();
    const studentUserIds = new Set<string>();
    db.paymentRequests.forEach(p => { if (p.userId) studentUserIds.add(p.userId); });
    db.subscriptions.forEach(s => { if (s.userId) studentUserIds.add(s.userId); });
    db.examResults.forEach(r => { if (r.userId) studentUserIds.add(r.userId); });
    const totalStudents = Math.max(studentUserIds.size, 1);

    const activeSubscribers = db.subscriptions.filter(
      s => s.status === 'active' && new Date(s.expiresAt).getTime() > now
    ).length;

    const pendingPayments = db.paymentRequests.filter(p => p.status === 'pending').length;
    const approvedPayments = db.paymentRequests.filter(p => p.status === 'approved').length;
    const rejectedPayments = db.paymentRequests.filter(p => p.status === 'rejected').length;

    const expiredSubscriptions = db.subscriptions.filter(
      s => s.status === 'expired' || new Date(s.expiresAt).getTime() <= now
    ).length;

    const totalVerifiedRevenue = db.paymentRequests
      .filter(p => p.status === 'approved')
      .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

    // Monthly revenue aggregation
    const monthlyMap: Record<string, {
      monthKey: string;
      monthLabelBn: string;
      monthLabelEn: string;
      totalRevenue: number;
      approvedCount: number;
      bkashRevenue: number;
      nagadRevenue: number;
      packages: Record<string, number>;
    }> = {};

    const monthNamesEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthNamesBn = ['জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর'];

    db.paymentRequests
      .filter(p => p.status === 'approved')
      .forEach(p => {
        const d = new Date(p.verifiedAt || p.requestedAt);
        const y = d.getFullYear();
        const m = d.getMonth();
        const monthKey = `${y}-${String(m + 1).padStart(2, '0')}`;
        
        if (!monthlyMap[monthKey]) {
          monthlyMap[monthKey] = {
            monthKey,
            monthLabelBn: `${monthNamesBn[m]} ${y}`,
            monthLabelEn: `${monthNamesEn[m]} ${y}`,
            totalRevenue: 0,
            approvedCount: 0,
            bkashRevenue: 0,
            nagadRevenue: 0,
            packages: {}
          };
        }

        const amt = Number(p.amount) || 0;
        monthlyMap[monthKey].totalRevenue += amt;
        monthlyMap[monthKey].approvedCount += 1;
        if (p.method === 'bKash') monthlyMap[monthKey].bkashRevenue += amt;
        else if (p.method === 'Nagad') monthlyMap[monthKey].nagadRevenue += amt;

        const pkgName = p.packageNameEn || p.packageId;
        monthlyMap[monthKey].packages[pkgName] = (monthlyMap[monthKey].packages[pkgName] || 0) + amt;
      });

    const monthlyReport = Object.values(monthlyMap).sort((a, b) => b.monthKey.localeCompare(a.monthKey));

    res.json({
      totalStudents,
      activeSubscribers,
      pendingPayments,
      approvedPayments,
      rejectedPayments,
      expiredSubscriptions,
      totalVerifiedRevenue,
      monthlyRevenueReport: monthlyReport
    });
  });

  // 7. Statutory Subjects, Questions & Exams APIs for Android & Web
  app.get('/api/subjects', (req, res) => {
    res.json({ subjects: db.subjects });
  });

  app.get('/api/exams', (req, res) => {
    res.json({ exams: db.exams });
  });

  app.get('/api/questions', (req, res) => {
    const { subjectId, examId } = req.query;
    let list = db.questions;
    if (subjectId) {
      list = list.filter(q => q.subjectId === subjectId);
    }
    if (examId) {
      const targetExam = db.exams.find(e => e.id === examId);
      if (targetExam) {
        list = list.filter(q => targetExam.questionIds.includes(q.id));
      }
    }
    res.json({ questions: list });
  });

  // Start Exam (Enforces session validity and subscription for paid exams)
  app.post('/api/exams/start', authenticateSession, (req, res) => {
    const session = (req as any).session;
    const { examId, userId, studentName } = req.body;
    const targetUserId = session?.userId || userId || 'user_candidate_786';

    const exam = db.exams.find(e => e.id === examId);
    if (!exam) {
      return res.status(404).json({ error: 'EXAM_NOT_FOUND', message: 'Exam not found' });
    }

    // Subscription check for paid exams
    if (exam.isPaid) {
      const activeSub = db.subscriptions.find(
        s => s.userId === targetUserId && s.status === 'active' && new Date(s.expiresAt).getTime() > Date.now()
      );
      if (!activeSub) {
        return res.status(403).json({
          error: 'SUBSCRIPTION_REQUIRED',
          message: 'এই ৬০ মিনিটের স্পেশাল মডেল টেস্টটি আনলক করতে প্রো সাবস্ক্রিপশন প্রয়োজন।'
        });
      }
    }

    const durationMinutes = exam.durationMinutes || 60;
    const now = new Date();
    const deadline = new Date(now.getTime() + durationMinutes * 60 * 1000);

    const attempt: ExamAttempt = {
      id: `attempt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      examId: exam.id,
      userId: targetUserId,
      sessionId: session?.sessionId,
      studentName: session?.userName || studentName || 'Student',
      startTime: now.toISOString(),
      deadlineTime: deadline.toISOString(),
      status: 'in_progress',
      answers: {},
      flaggedQuestionIds: [],
      currentQuestionIndex: 0,
      lastSavedAt: now.toISOString()
    };

    db.examAttempts[attempt.id] = attempt;

    res.json({
      success: true,
      attempt,
      durationMinutes,
      deadlineTime: attempt.deadlineTime
    });
  });

  // Submit Exam (Trusted server-authoritative scoring: +1 correct, -0.25 incorrect)
  app.post('/api/exams/submit', authenticateSession, (req, res) => {
    const { attemptId, answers } = req.body;
    const attempt = db.examAttempts[attemptId];

    if (!attempt) {
      return res.status(404).json({ error: 'ATTEMPT_NOT_FOUND', message: 'Exam attempt not found' });
    }

    if (attempt.status !== 'in_progress') {
      return res.status(400).json({ error: 'ALREADY_SUBMITTED', message: 'Attempt has already been submitted' });
    }

    const exam = db.exams.find(e => e.id === attempt.examId);
    if (!exam) {
      return res.status(404).json({ error: 'EXAM_NOT_FOUND', message: 'Exam not found' });
    }

    const examQuestions = db.questions.filter(q => exam.questionIds.includes(q.id));
    const mergedAnswers: Record<string, number> = answers || attempt.answers || {};

    // Calculate score
    const scoreResult = calculateExamScore(mergedAnswers, examQuestions, {
      positiveMarkRatio: exam.positiveMarkRatio ?? 1.0,
      negativeMarkRatio: exam.negativeMarkRatio ?? 0.25,
      passThresholdPercentage: exam.passThresholdPercentage
    });

    const startTime = new Date(attempt.startTime).getTime();
    const submissionTime = Date.now();
    const timeSpentSeconds = Math.max(1, Math.round((submissionTime - startTime) / 1000));

    // Subject breakdown
    const subjectScores: ExamResult['subjectWiseScores'] = {};
    for (const sub of db.subjects) {
      const subQuestions = examQuestions.filter(q => q.subjectId === sub.id);
      if (subQuestions.length > 0) {
        let correct = 0;
        let incorrect = 0;
        let unanswered = 0;
        for (const q of subQuestions) {
          const ans = mergedAnswers[q.id];
          if (ans === undefined || ans === null) unanswered++;
          else if (ans === q.correctOptionIndex) correct++;
          else incorrect++;
        }
        const score = Math.round((correct * 1.0 - incorrect * 0.25) * 100) / 100;
        subjectScores[sub.id] = {
          subjectNameBn: sub.nameBn,
          subjectNameEn: sub.nameEn,
          total: subQuestions.length,
          correct,
          incorrect,
          unanswered,
          score
        };
      }
    }

    const newResult: ExamResult = {
      id: `res_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      attemptId: attempt.id,
      examId: exam.id,
      examTitleBn: exam.titleBn,
      examTitleEn: exam.titleEn,
      examType: exam.type,
      userId: attempt.userId,
      studentName: attempt.studentName,
      submittedAt: new Date().toISOString(),
      timeSpentSeconds,
      totalQuestions: scoreResult.totalQuestions,
      correctAnswersCount: scoreResult.correctAnswersCount,
      incorrectAnswersCount: scoreResult.incorrectAnswersCount,
      unansweredCount: scoreResult.unansweredCount,
      positiveMarks: scoreResult.positiveMarks,
      negativeMarks: scoreResult.negativeMarks,
      finalScore: scoreResult.finalScore,
      percentage: scoreResult.percentage,
      passed: scoreResult.passed,
      passThresholdPercentage: exam.passThresholdPercentage,
      subjectWiseScores: subjectScores,
      answers: mergedAnswers,
      questions: examQuestions
    };

    attempt.status = 'submitted';
    attempt.submittedTime = newResult.submittedAt;
    db.examResults.unshift(newResult);

    res.json({
      success: true,
      result: newResult
    });
  });

  app.get('/api/exams/results/:userId', (req, res) => {
    const { userId } = req.params;
    const list = db.examResults.filter(r => r.userId === userId);
    res.json({ results: list });
  });

  // Audit Logs
  app.get('/api/admin/audit-logs', (req, res) => {
    res.json({ auditLogs: db.auditLogs });
  });

  // Mount Vite in development or static dist in production
  const distDir = path.resolve(__dirname, 'dist');
  const distIndex = path.resolve(distDir, 'index.html');
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction && fs.existsSync(distIndex)) {
    app.use(express.static(distDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) {
        return next();
      }
      res.sendFile(distIndex);
    });
  } else {
    const vite = await createViteServer({
      server: { 
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : undefined
      },
      appType: 'spa'
    });
    app.use(vite.middlewares);

    // Fallback for SPA routing in development mode
    app.get('*', async (req, res, next) => {
      if (req.path.startsWith('/api')) {
        return next();
      }
      try {
        const indexPath = path.resolve(__dirname, 'index.html');
        let template = fs.readFileSync(indexPath, 'utf-8');
        template = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e) {
        next(e);
      }
    });
  }

  // Parse --port CLI argument or fallback to 3000 (AI Studio requires port 3000)
  const portArgIndex = process.argv.indexOf('--port');
  const cliPort = portArgIndex !== -1 ? Number(process.argv[portArgIndex + 1]) : null;
  const PORT = cliPort || (isProduction && process.env.PORT ? Number(process.env.PORT) : 3000);

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Sanad Prep BD Engine running on port ${PORT} [mode: ${isProduction ? 'production' : 'development'}]`);
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use.`);
    } else {
      console.error('Server error:', err);
    }
  });

  const handleShutdown = () => {
    server.close(() => {
      process.exit(0);
    });
  };
  process.on('SIGTERM', handleShutdown);
  process.on('SIGINT', handleShutdown);
}

startServer();
