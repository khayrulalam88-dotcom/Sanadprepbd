import type { SubscriptionPackage, ExamDateConfig } from '../types/index.ts';

export const INITIAL_PACKAGES: SubscriptionPackage[] = [
  {
    id: 'pkg_monthly',
    nameBn: 'মাসিক সাবস্ক্রিপশন (Monthly Subscription)',
    nameEn: 'Monthly Subscription',
    taglineBn: 'মাসিক ভিত্তিতে সাশ্রয়ী ফি পরিশোধ করে সকল মডেল টেস্ট ও পেইড MCQ অনুশীলন',
    taglineEn: 'Flexible 30-day monthly access for all model tests & question bank',
    price: 150,
    validityType: 'days',
    durationDays: 30,
    accessLevel: 'pro_mock',
    billingType: 'monthly',
    featuresBn: [
      '৩০ দিনের সকল ৬০ মিনিটের মডেল টেস্ট এক্সেস',
      '৭টি মূল আইনের পেইড MCQ ব্যাংক ও সঠিক ব্যাখ্যা',
      'অফিসিয়াল নেগেটিভ মার্কিং (+১.০০ / -০.২৫)',
      'মাস শেষে পছন্দমতো পুনরায় রিনিউ করার সুবিধা',
      'তাৎক্ষণিক মেধা তালিকা ও ফলাফল পর্যালোচনা'
    ],
    featuresEn: [
      'All 60-minute full mock tests for 30 days',
      'Premium statutory question bank with explanations',
      'Official negative marking (+1.0 / -0.25)',
      'Flexible month-by-month renewal option',
      'Instant ranking & performance analysis'
    ],
    badgeBn: 'মাসিক প্ল্যান (৩০ দিন)',
    badgeEn: '30 Days',
    popular: false,
    isActive: true,
    isArchived: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z'
  },
  {
    id: 'pkg_long_course',
    nameBn: 'লং কোর্স (Long Course - ১ বছর)',
    nameEn: 'Long Course Pass (365 Days)',
    taglineBn: '৭টি আইনের পূর্ণাঙ্গ অধ্যায়ভিত্তিক অনুশীলন ও সকল মডেল টেস্টের ৩৬৫ দিন মেয়াদী মাস্টার প্যাক',
    taglineEn: 'Comprehensive 1-year master package: subject practice & all model tests',
    price: 999,
    validityType: 'days',
    durationDays: 365,
    accessLevel: 'long_course',
    billingType: 'onetime',
    featuresBn: [
      '৭টি মূল আইনের সকল ধারাভিত্তিক এমসিকিউ প্র্যাকটিস ব্যাংক',
      '৬০ মিনিটের সকল পূর্ণাঙ্গ ১০০ নম্বরের স্পেশাল মডেল টেস্ট',
      'নেগেটিভ মার্কিং, ফলাফল আর্কাইভ ও অগ্রগতি ট্র্যাকার',
      'প্রিমিয়াম প্রস্তুতিমূলক গাইডলাইন ও রেফারেন্স মেটেরিয়াল',
      '৩৬৫ দিন (পূর্ণ ১ বছর) নিরবচ্ছিন্ন এক্সেস'
    ],
    featuresEn: [
      'Complete question bank across all 7 statutory codes',
      'All 60-minute 100-mark model examinations',
      'Detailed analytics & historical score tracking',
      'Premium reference guidelines & bare act notes',
      '365 days (Full 1 Year) continuous validity'
    ],
    badgeBn: 'সর্বাধিক জনপ্রিয় (Popular)',
    badgeEn: 'Best Value',
    popular: true,
    isActive: true,
    isArchived: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z'
  },
  {
    id: 'pkg_exam_pass',
    nameBn: 'বার কাউন্সিল এক্সাম পাস (Exam Pass)',
    nameEn: 'Bar Council Exam Pass (Until Exam Date)',
    taglineBn: 'আসন্ন বার কাউন্সিল এনরোলমেন্ট পরীক্ষার দিন পর্যন্ত সম্পূর্ণ প্রস্তুতি এক্সেস',
    taglineEn: 'Complete all-inclusive preparation until target Bar Council exam day',
    price: 650, // Configurable by admin
    validityType: 'exam_date',
    accessLevel: 'all_inclusive',
    billingType: 'onetime',
    featuresBn: [
      'আসন্ন বার কাউন্সিল পরীক্ষার দিন পর্যন্ত আনলিমিটেড এক্সেস',
      'সরকারি পরীক্ষার শিডিউল পরিবর্তন হলে স্বয়ংক্রিয় মেয়াদ সমন্বয়',
      'সকল অধ্যায়ভিত্তিক অনুশীলন ও স্পেশাল মডেল টেস্ট',
      'বিস্তারিত ব্যাখ্যা, সেকশন রেফারেন্স ও পরীক্ষার টিপস',
      'পরীক্ষা পূর্ববর্তী স্পেশাল রিভিশন টেস্ট মেটেরিয়াল'
    ],
    featuresEn: [
      'Unlimited access until target Bar Council exam day',
      'Automatic validity adjustment if official schedule shifts',
      'All subject-wise practice & 100-mark model tests',
      'Statutory explanations, legal references & tips',
      'Pre-exam high-yield revision test series'
    ],
    badgeBn: 'পরীক্ষার্থীদের প্রথম পছন্দ (Exam Ready)',
    badgeEn: 'Exam Ready',
    popular: false,
    isActive: true,
    isArchived: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z'
  },
  {
    id: 'pkg_pro_mock',
    nameBn: 'প্রো মডেল টেস্ট পাস (লিগ্যাসি ৯০ দিন)',
    nameEn: 'Pro Model Test Pass (Legacy 90 Days)',
    taglineBn: 'পূর্ণাঙ্গ ৬০ মিনিটের ১০০ নম্বরের স্পেশাল মডেল টেস্ট প্রস্তুতি',
    taglineEn: 'Full-length 100-mark 60-min timed model tests',
    price: 300,
    validityType: 'days',
    durationDays: 90,
    accessLevel: 'pro_mock',
    billingType: 'onetime',
    featuresBn: [
      '৬০ মিনিটের সকল পূর্ণাঙ্গ ১০০ নম্বরের মডেল টেস্ট',
      'অফিসিয়াল নেগেティブ মার্কিং (+১.০০ / -০.২৫)'
    ],
    featuresEn: [
      'All 60-minute full 100-mark model tests',
      'Official negative marking (+1.0 / -0.25)'
    ],
    badgeBn: 'আর্কাইভড',
    badgeEn: 'Archived',
    popular: false,
    isActive: false, // Archived so only the 3 core packages are active
    isArchived: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z'
  }
];

export const INITIAL_EXAM_DATE_CONFIG: ExamDateConfig = {
  targetExamDate: '2026-11-28T09:00:00+06:00', // 28 November 2026 09:00 AM BST
  timezone: 'Asia/Dhaka', // Bangladesh Standard Time (UTC+6)
  examDatePolicy: 'extend_all', // 'extend_all' or 'new_only'
  examPassPrice: 650,
  examTitleBn: 'বাংলাদেশ বার কাউন্সিল এনরোলমেন্ট এমসিকিউ পরীক্ষা ২০২৬',
  examTitleEn: 'Bangladesh Bar Council Enrollment MCQ Examination 2026',
  lastUpdated: new Date().toISOString()
};
