import type { Metadata } from 'next';
import { Atkinson_Hyperlegible, JetBrains_Mono } from 'next/font/google';
import { ThemeProvider, NO_FLASH_SCRIPT } from '../components/theme/ThemeProvider';
import './globals.css';

const atkinson = Atkinson_Hyperlegible({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-atkinson',
  display: 'swap',
});

const jbMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-jb-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Autonomous Sentinel',
  description: 'EAM Watch — Emergency Action Message broadcast catalog.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${atkinson.variable} ${jbMono.variable}`} suppressHydrationWarning>
      <head>
        <script
          // No-FOUC: set data-theme from localStorage before first paint.
          dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }}
        />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
