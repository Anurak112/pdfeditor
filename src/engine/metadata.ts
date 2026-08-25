/**
 * The document information dictionary — who made this file, and what it is.
 *
 * Merge, Split and Organize all build a brand-new PDFDocument and copy pages
 * into it, and a new document knows nothing about where its pages came from.
 * Left to itself pdf-lib fills that emptiness with its own name and today's
 * date; each tool then wrote 'Simple PDF' over the top of that, which looked
 * like a fix and was the same mistake with better branding.
 *
 * /Producer and /Creator are not two words for one thing:
 *
 *   Producer — the program that wrote *this file*. That is us, always.
 *   Creator  — the program that authored the *content*. Turning page 3 upright,
 *              or pulling pages 4-9 out of a certificate, does not make us the
 *              author of the certificate.
 *
 * Overwriting Creator caused the kind of loss that never gets reported: the
 * file still opens, every page is there, and the only thing missing is the name
 * of the system that issued the document — which nobody looks at until they
 * need it. So Creator travels across from the source now, and only Producer
 * carries our name.
 *
 * Not carried: the XMP packet in /Metadata, which is where a modern producer
 * keeps a second copy of all this. pdf-lib has no API for it and a new document
 * simply has none, so an output from these three tools has an Info dictionary
 * and no XMP. That is a real gap, and a bigger job than this one.
 */
import { PDFDocument } from 'pdf-lib';

/** What goes in /Producer, because this app is what wrote the bytes. */
export const APP_NAME = 'Simple PDF';

export interface CarryOptions {
  /**
   * Carry /CreationDate too.
   *
   * True for the single-source tools: rearranging or extracting pages leaves
   * the same work, made whenever it was made. False for Merge, where the
   * output is a compilation that genuinely did not exist until now, even when
   * the user asked for its description to come from the first file.
   */
  creationDate?: boolean;
}

/**
 * A new document with nothing written in its information dictionary.
 *
 * pdf-lib's create() stamps its own name into /Producer and /Creator unless
 * told not to. Every tool here that builds a document starts from this instead,
 * so that what ends up in the file is only what someone decided to put there.
 */
export async function blankDocument(): Promise<PDFDocument> {
  return PDFDocument.create({ updateMetadata: false });
}

/**
 * Fills the output's information dictionary from the document it came out of.
 *
 * `source` is null when the output is not derived from any one document, or
 * when the user asked for the description to be left out. Either way /Producer
 * says this app and /ModDate says now, because both are true of every file that
 * leaves here.
 */
export function carryInfo(out: PDFDocument, source: PDFDocument | null, options: CarryOptions = {}) {
  const now = new Date();
  let created: Date | undefined;

  if (source) {
    const title = read(() => source.getTitle());
    const author = read(() => source.getAuthor());
    const subject = read(() => source.getSubject());
    const keywords = read(() => source.getKeywords());
    const creator = read(() => source.getCreator());
    created = options.creationDate ? read(() => source.getCreationDate()) : undefined;

    if (title) out.setTitle(title);
    if (author) out.setAuthor(author);
    if (subject) out.setSubject(subject);
    // setKeywords takes a list and joins it with spaces, so handing it the one
    // string the file stores gets that string back out unchanged. Splitting on
    // commas first would quietly turn "invoice, august" into "invoice august" —
    // and we are carrying this value across, not re-writing it.
    if (keywords) out.setKeywords([keywords]);
    if (creator) out.setCreator(creator);
  }

  out.setProducer(APP_NAME);
  // Falling back to now when there is no date to carry, or the source's own is
  // unreadable: a file with no /CreationDate at all shows an empty column in
  // every reader, and "made just now" is at least true of the bytes in hand.
  out.setCreationDate(created ?? now);
  out.setModificationDate(now);
}

/**
 * For a document this app really did author — Convert, building pages out of
 * loose images. There is no earlier program to credit, so Creator is us too.
 *
 * It lives next to carryInfo so that the difference between the two stays a
 * decision someone made, rather than a line that got copied into a tool where
 * it was not true.
 */
export function stampAuthored(pdf: PDFDocument) {
  const now = new Date();
  pdf.setProducer(APP_NAME);
  pdf.setCreator(APP_NAME);
  pdf.setCreationDate(now);
  pdf.setModificationDate(now);
}

/**
 * Reads one metadata field, or gives up on it.
 *
 * Every one of pdf-lib's getters throws if the entry is not the type it
 * expects, and getCreationDate throws again if the date string does not parse —
 * both of which real files in the wild get wrong. A malformed /CreationDate is
 * the source document's problem; it is not a reason to fail a job whose actual
 * work is turning pages, so the bad field is skipped and the rest still travel.
 */
function read<T>(get: () => T | undefined): T | undefined {
  try {
    return get();
  } catch {
    return undefined;
  }
}
