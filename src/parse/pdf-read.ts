import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PdfPage } from './pdf';

export interface PdfContent {
  pages: PdfPage[];
  /** Titles from the document's outline (bookmarks), in order; empty when it has none. */
  outline: string[];
}

/** Read the positioned text of every page of a PDF with pdf.js (loaded only when a PDF is opened). */
export async function readPdf(data: ArrayBuffer): Promise<PdfContent> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages: PdfPage[] = [];
  const outline: string[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const { width, height } = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      pages.push({
        width,
        height,
        items: content.items.flatMap((item) =>
          'str' in item
            ? [{ str: item.str, x: item.transform[4], y: item.transform[5], size: Math.hypot(item.transform[2], item.transform[3]), width: item.width }]
            : [],
        ),
      });
    }
    type Entry = { title: string; items?: Entry[] };
    const collect = (entries: Entry[] | null | undefined): void => {
      for (const entry of entries ?? []) {
        if (entry.title?.trim()) outline.push(entry.title.trim());
        collect(entry.items);
      }
    };
    collect((await doc.getOutline().catch(() => null)) as Entry[] | null);
  } finally {
    void doc.loadingTask.destroy();
  }
  return { pages, outline };
}
