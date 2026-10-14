export { PdfTextEditor, type LineInfo, type EditReport, type FontMode } from './editor';
export { FontLibrary, ShapingFont } from './fontlib';
export { Subsetter } from './subset';

/** Fonts bundled with the app (OFL / Bitstream Vera licences, see fonts/). */
export const BUNDLED_FONTS = [
  { id: 'naskh-regular', file: 'NotoNaskhArabic-Regular.ttf', family: 'Noto Naskh Arabic', psName: 'NotoNaskhArabic-Regular', bold: false },
  { id: 'naskh-bold', file: 'NotoNaskhArabic-Bold.ttf', family: 'Noto Naskh Arabic', psName: 'NotoNaskhArabic-Bold', bold: true },
  { id: 'dejavu-regular', file: 'DejaVuSans.ttf', family: 'DejaVu Sans', psName: 'DejaVuSans', bold: false },
  { id: 'dejavu-bold', file: 'DejaVuSans-Bold.ttf', family: 'DejaVu Sans', psName: 'DejaVuSans-Bold', bold: true },
] as const;
