import type { Metadata } from 'next';
import './globals.css';
export const metadata:Metadata={title:'SIGMET / May 2026 replay',description:'Replay the supplied May 2026 SIGMET archive with warning banners, reported polygons and decoded messages.'};
export default function RootLayout({children}:{children:React.ReactNode}) {
  return <html lang="en"><body>{children}</body></html>;
}
