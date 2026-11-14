import React from 'react';
import { useApp } from '../context/AppContext';
import { MessageCircle } from 'lucide-react';

interface Props {
  variant?: 'button' | 'compact' | 'card' | 'outline';
  customText?: string;
  className?: string;
  specificContextMessage?: string;
}

export const WhatsAppSupportButton: React.FC<Props> = ({
  variant = 'button',
  customText,
  className = '',
  specificContextMessage
}) => {
  const { supportSettings, language, t } = useApp();

  const handleOpenWhatsApp = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Clean phone number: remove +, -, spaces
    const cleanNumber = (supportSettings.whatsappNumber || '+8801671819027').replace(/[^0-9]/g, '');
    const message = specificContextMessage || supportSettings.whatsappMessage || 'Hello Sanad Prep BD Support, I need help with my account or subscription.';
    
    const waUrl = `https://wa.me/${cleanNumber}?text=${encodeURIComponent(message)}`;
    
    // Works reliably on Android mobile browsers and desktop browsers
    window.open(waUrl, '_blank', 'noopener,noreferrer');
  };

  const buttonLabel = customText || (language === 'bn' ? 'হোয়াটসঅ্যাপ সাপোর্ট (+৮৮০১৬৭১৮১৯০২৭)' : 'WhatsApp Support');

  if (variant === 'compact') {
    return (
      <button
        onClick={handleOpenWhatsApp}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#25D366] hover:bg-[#20ba59] text-white font-bold text-xs transition shadow-xs cursor-pointer active:scale-95 ${className}`}
        title="Chat on WhatsApp"
        type="button"
      >
        <MessageCircle className="w-3.5 h-3.5 fill-current" />
        <span>{buttonLabel}</span>
      </button>
    );
  }

  if (variant === 'outline') {
    return (
      <button
        onClick={handleOpenWhatsApp}
        className={`inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border-2 border-[#25D366] text-[#128C7E] hover:bg-[#25D366]/10 font-bold text-xs sm:text-sm transition cursor-pointer active:scale-95 ${className}`}
        title="Chat on WhatsApp"
        type="button"
      >
        <MessageCircle className="w-4 h-4 text-[#25D366] fill-current" />
        <span>{buttonLabel}</span>
      </button>
    );
  }

  if (variant === 'card') {
    return (
      <div className={`p-4 rounded-2xl bg-emerald-50/70 border border-emerald-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${className}`}>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#25D366] text-white flex items-center justify-center shrink-0 shadow-sm">
            <MessageCircle className="w-5 h-5 fill-current" />
          </div>
          <div>
            <h4 className="font-bold text-slate-900 text-sm">
              {t('তাৎক্ষণিক সহায়তা প্রয়োজন?', 'Need Instant Assistance?')}
            </h4>
            <p className="text-xs text-slate-600">
              {t(
                `আমাদের অফিসিয়াল হোয়াটসঅ্যাপে যোগাযোগ করুন (${supportSettings.whatsappNumber})`,
                `Chat directly with our support team on WhatsApp (${supportSettings.whatsappNumber})`
              )}
            </p>
          </div>
        </div>

        <button
          onClick={handleOpenWhatsApp}
          className="px-4 py-2 rounded-xl bg-[#25D366] hover:bg-[#20ba59] text-white font-bold text-xs shrink-0 flex items-center justify-center gap-2 shadow-sm cursor-pointer transition active:scale-95"
          type="button"
        >
          <MessageCircle className="w-4 h-4 fill-current" />
          <span>{t('মেসেজ পাঠান', 'Send Message')}</span>
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={handleOpenWhatsApp}
      className={`inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-[#25D366] hover:bg-[#20ba59] text-white font-bold text-xs sm:text-sm shadow-md shadow-[#25D366]/20 transition cursor-pointer active:scale-95 ${className}`}
      title="Contact WhatsApp Support"
      type="button"
    >
      <MessageCircle className="w-4 h-4 fill-current" />
      <span>{buttonLabel}</span>
    </button>
  );
};
