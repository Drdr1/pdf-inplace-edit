export { PdfTextEditor, type LineInfo, type EditReport, type FontMode } from './editor';
export { FontLibrary, ShapingFont } from './fontlib';
export { Subsetter } from './subset';

/** Fonts bundled with the app (OFL, Bitstream Vera, GPL+font-exception licences; see fonts/). */
export const BUNDLED_FONTS = [
  { id: 'naskh-regular', file: 'NotoNaskhArabic-Regular.ttf', family: 'Noto Naskh Arabic', psName: 'NotoNaskhArabic-Regular', bold: false },
  { id: 'naskh-bold', file: 'NotoNaskhArabic-Bold.ttf', family: 'Noto Naskh Arabic', psName: 'NotoNaskhArabic-Bold', bold: true },
  { id: 'dejavu-regular', file: 'DejaVuSans.ttf', family: 'DejaVu Sans', psName: 'DejaVuSans', bold: false },
  { id: 'dejavu-bold', file: 'DejaVuSans-Bold.ttf', family: 'DejaVu Sans', psName: 'DejaVuSans-Bold', bold: true },
  { id: 'liberation-serif-regular', file: 'LiberationSerif-Regular.ttf', family: 'Liberation Serif', psName: 'LiberationSerif', bold: false },
  { id: 'liberation-serif-bold', file: 'LiberationSerif-Bold.ttf', family: 'Liberation Serif', psName: 'LiberationSerif-Bold', bold: true },
  { id: 'freesans-bold', file: 'FreeSansBold.ttf', family: 'FreeSans', psName: 'FreeSansBold', bold: true },
  { id: 'freeserif-bold', file: 'FreeSerifBold.ttf', family: 'FreeSerif', psName: 'FreeSerifBold', bold: true },
] as const;
