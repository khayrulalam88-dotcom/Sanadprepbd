import React from 'react';

interface LogoProps {
  className?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  variant?: 'full' | 'navbar' | 'mark-only';
  theme?: 'dark' | 'light'; // dark text for light bg, light text for navy bg
  showTagline?: boolean;
  language?: 'bn' | 'en';
}

export const Logo: React.FC<LogoProps> = ({
  className = '',
  size = 'md',
  variant = 'navbar',
  theme = 'dark',
  showTagline = true,
  language = 'bn'
}) => {
  const iconSizes = {
    sm: 'w-7 h-7',
    md: 'w-9 h-9',
    lg: 'w-11 h-11',
    xl: 'w-14 h-14'
  };

  const textSizes = {
    sm: 'text-base',
    md: 'text-xl',
    lg: 'text-2xl',
    xl: 'text-3xl'
  };

  const isLight = theme === 'light';

  return (
    <div className={`flex items-center gap-2.5 select-none ${className}`}>
      {/* 3-Pill Iconic Brand Mark (Yellow, Blue, Orange) matching the reference */}
      <div className={`relative ${iconSizes[size]} shrink-0 flex items-center justify-center`}>
        <svg 
          viewBox="0 0 44 44" 
          fill="none" 
          xmlns="http://www.w3.org/2000/svg"
          className="w-full h-full drop-shadow-xs"
        >
          {/* Top-Left Rounded Square: Warm Amber/Yellow */}
          <rect 
            x="3" 
            y="3" 
            width="17" 
            height="17" 
            rx="5.5" 
            fill="#F59E0B" 
          />
          {/* Bottom-Left Rounded Square: Vibrant Royal Blue */}
          <rect 
            x="3" 
            y="24" 
            width="17" 
            height="17" 
            rx="5.5" 
            fill="#2563EB" 
          />
          {/* Right Rounded Vertical Capsule: Warm Red-Orange */}
          <rect 
            x="24" 
            y="3" 
            width="17" 
            height="38" 
            rx="6.5" 
            fill="#EA580C" 
          />
        </svg>
      </div>

      {variant !== 'mark-only' && (
        <div className="flex flex-col text-left">
          <div className="flex items-center gap-1.5 leading-none">
            <span className={`font-black tracking-tight ${textSizes[size]} ${isLight ? 'text-white' : 'text-slate-900'}`}>
              Sanad Prep
            </span>
            <span className="font-black tracking-tight text-[#EA580C] text-lg sm:text-xl">
              BD
            </span>
          </div>

          {(showTagline || variant === 'full' || variant === 'navbar') && (
            <p className={`text-[10px] sm:text-[11px] font-semibold tracking-tight mt-1 ${isLight ? 'text-slate-300' : 'text-slate-600'}`}>
              {language === 'bn' ? 'অনুশীলনে দক্ষতা, প্রস্তুতিতে আত্মবিশ্বাস' : 'Skill in Practice, Confidence in Preparation'}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
