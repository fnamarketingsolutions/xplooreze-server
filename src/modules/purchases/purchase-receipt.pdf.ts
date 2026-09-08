import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

import { formatPurchaseAmount } from '../notifications/email-templates';
import { formatReceiptIssuedAt, type PurchaseReceiptSnapshot } from './purchase-receipt';

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const NAVY = rgb(0.067, 0.133, 0.2);
const ORANGE = rgb(0.929, 0.353, 0.035);
const INK = rgb(0.12, 0.14, 0.16);
const MUTED = rgb(0.36, 0.4, 0.44);
const LINE = rgb(0.89, 0.87, 0.84);
const SURFACE = rgb(0.973, 0.969, 0.957);
const WHITE = rgb(1, 1, 1);
const HEADER_MUTED = rgb(0.82, 0.8, 0.76);

function displayOrDash(value: string): string {
  const text = value.trim();
  return text === '' ? '—' : text;
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) {
    return ['—'];
  }

  const lines: string[] = [];
  let current = '';

  const pushLongWord = (word: string) => {
    let rest = word;
    while (font.widthOfTextAtSize(rest, size) > maxWidth && rest.length > 1) {
      let cut = rest.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxWidth) {
        cut -= 1;
      }
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    current = rest;
  };

  for (const word of words) {
    const next = current === '' ? word : `${current} ${word}`;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) {
      current = next;
      continue;
    }
    if (current !== '') {
      lines.push(current);
      current = '';
    }
    if (font.widthOfTextAtSize(word, size) > maxWidth) {
      pushLongWord(word);
    } else {
      current = word;
    }
  }

  if (current !== '') {
    lines.push(current);
  }

  return lines.length > 0 ? lines : ['—'];
}

function drawRight(
  page: PDFPage,
  text: string,
  right: number,
  y: number,
  size: number,
  font: PDFFont,
  color = INK,
) {
  const width = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: right - width, y, size, font, color });
}

export async function renderPurchaseReceiptPdf(receipt: PurchaseReceiptSnapshot): Promise<Buffer> {
  const document = await PDFDocument.create();
  const page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);

  const headerHeight = 118;
  page.drawRectangle({
    x: 0,
    y: PAGE_HEIGHT - headerHeight,
    width: PAGE_WIDTH,
    height: headerHeight,
    color: NAVY,
  });
  page.drawRectangle({
    x: 0,
    y: PAGE_HEIGHT - headerHeight - 4,
    width: PAGE_WIDTH,
    height: 4,
    color: ORANGE,
  });

  page.drawText(receipt.sellerName, {
    x: MARGIN,
    y: PAGE_HEIGHT - 46,
    size: 22,
    font: bold,
    color: WHITE,
  });
  page.drawText(receipt.sellerEmail, {
    x: MARGIN,
    y: PAGE_HEIGHT - 68,
    size: 9,
    font: regular,
    color: HEADER_MUTED,
  });
  page.drawText(receipt.sellerPhone, {
    x: MARGIN,
    y: PAGE_HEIGHT - 82,
    size: 9,
    font: regular,
    color: HEADER_MUTED,
  });

  const receiptLabel = 'PAYMENT RECEIPT';
  drawRight(page, receiptLabel, PAGE_WIDTH - MARGIN, PAGE_HEIGHT - 42, 10, bold, ORANGE);
  drawRight(page, receipt.number, PAGE_WIDTH - MARGIN, PAGE_HEIGHT - 64, 13, bold, WHITE);
  drawRight(page, 'Paid', PAGE_WIDTH - MARGIN, PAGE_HEIGHT - 82, 9, regular, HEADER_MUTED);

  let y = PAGE_HEIGHT - headerHeight - 36;

  const issuedLabel = 'Issued';
  const billedLabel = 'Billed to';
  const paymentLabel = 'Payment reference';
  const metaGap = 16;
  const metaWidth = (CONTENT_WIDTH - metaGap) / 2;
  const metaHeight = 62;

  page.drawRectangle({
    x: MARGIN,
    y: y - metaHeight,
    width: metaWidth,
    height: metaHeight,
    color: SURFACE,
  });
  page.drawRectangle({
    x: MARGIN + metaWidth + metaGap,
    y: y - metaHeight,
    width: metaWidth,
    height: metaHeight,
    color: SURFACE,
  });

  const metaTextY = y - 22;
  page.drawText(issuedLabel.toUpperCase(), {
    x: MARGIN + 14,
    y: metaTextY,
    size: 8,
    font: bold,
    color: MUTED,
  });
  page.drawText(formatReceiptIssuedAt(receipt.issuedAt), {
    x: MARGIN + 14,
    y: metaTextY - 18,
    size: 10,
    font: regular,
    color: INK,
  });

  const paymentX = MARGIN + metaWidth + metaGap + 14;
  page.drawText(paymentLabel.toUpperCase(), {
    x: paymentX,
    y: metaTextY,
    size: 8,
    font: bold,
    color: MUTED,
  });
  const paymentLines = wrapText(
    displayOrDash(receipt.razorpayPaymentId),
    regular,
    10,
    metaWidth - 28,
  );
  paymentLines.slice(0, 2).forEach((line, index) => {
    page.drawText(line, {
      x: paymentX,
      y: metaTextY - 18 - index * 13,
      size: 10,
      font: regular,
      color: INK,
    });
  });

  y -= metaHeight + 28;

  page.drawText(billedLabel.toUpperCase(), {
    x: MARGIN,
    y,
    size: 8,
    font: bold,
    color: MUTED,
  });
  y -= 18;
  page.drawText(displayOrDash(receipt.studentName), {
    x: MARGIN,
    y,
    size: 12,
    font: bold,
    color: INK,
  });
  y -= 16;
  page.drawText(displayOrDash(receipt.studentEmail), {
    x: MARGIN,
    y,
    size: 10,
    font: regular,
    color: MUTED,
  });

  y -= 28;

  const amountHeader = 'Amount';
  const amountColWidth = 120;
  const descX = MARGIN + 14;
  const amountRight = PAGE_WIDTH - MARGIN - 14;
  const tableTop = y;
  const headerRowHeight = 28;

  page.drawRectangle({
    x: MARGIN,
    y: tableTop - headerRowHeight,
    width: CONTENT_WIDTH,
    height: headerRowHeight,
    color: NAVY,
  });
  page.drawText('DESCRIPTION', {
    x: descX,
    y: tableTop - 18,
    size: 8,
    font: bold,
    color: WHITE,
  });
  drawRight(page, amountHeader.toUpperCase(), amountRight, tableTop - 18, 8, bold, WHITE);

  const descriptionLines = wrapText(
    displayOrDash(receipt.testSeriesTitle),
    bold,
    11,
    CONTENT_WIDTH - amountColWidth - 36,
  );
  const lineGap = 14;
  const rowPad = 16;
  const rowHeight = rowPad * 2 + descriptionLines.length * lineGap + 12;
  const rowTop = tableTop - headerRowHeight;

  page.drawRectangle({
    x: MARGIN,
    y: rowTop - rowHeight,
    width: CONTENT_WIDTH,
    height: rowHeight,
    borderColor: LINE,
    borderWidth: 1,
  });

  descriptionLines.forEach((line, index) => {
    page.drawText(line, {
      x: descX,
      y: rowTop - 22 - index * lineGap,
      size: 11,
      font: bold,
      color: INK,
    });
  });
  page.drawText('Test series access', {
    x: descX,
    y: rowTop - 22 - descriptionLines.length * lineGap,
    size: 9,
    font: regular,
    color: MUTED,
  });

  const amountLabel = formatPurchaseAmount(receipt.amount, receipt.currency);
  const amountSize = 11;
  const amountY = rowTop - rowHeight / 2 - amountSize / 2 + 1;
  drawRight(page, amountLabel, amountRight, amountY, amountSize, bold, INK);

  const totalTop = rowTop - rowHeight;
  const totalHeight = 36;
  page.drawRectangle({
    x: MARGIN,
    y: totalTop - totalHeight,
    width: CONTENT_WIDTH,
    height: totalHeight,
    color: SURFACE,
    borderColor: LINE,
    borderWidth: 1,
  });
  page.drawText('Total paid', {
    x: descX,
    y: totalTop - 23,
    size: 11,
    font: bold,
    color: INK,
  });
  drawRight(page, amountLabel, amountRight, totalTop - 23, 12, bold, NAVY);

  const footerY = 56;
  page.drawLine({
    start: { x: MARGIN, y: footerY + 18 },
    end: { x: PAGE_WIDTH - MARGIN, y: footerY + 18 },
    thickness: 1,
    color: LINE,
  });
  page.drawText('This is a payment receipt, not a tax invoice.', {
    x: MARGIN,
    y: footerY,
    size: 8,
    font: regular,
    color: MUTED,
  });
  drawRight(page, receipt.sellerName, PAGE_WIDTH - MARGIN, footerY, 8, regular, MUTED);

  const bytes = await document.save();
  return Buffer.from(bytes);
}
