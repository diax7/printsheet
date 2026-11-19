/**
 * pdf.js's own worker, bundled inline so the app stays one file and the page's security policy
 * (workers from blob: only) allows it.
 */
// oxlint-disable-next-line import/no-unassigned-import -- loading the module starts the pdf.js worker.
import 'pdfjs-dist/build/pdf.worker.min.mjs';
