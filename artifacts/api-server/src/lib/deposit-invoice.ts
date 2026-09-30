import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { NotificationAttachment } from "./mailtrap-notification-client";

export interface DepositInvoiceInput {
  id: string;
  createdAt: string | Date;
  customerName?: string | null;
  customerEmail?: string | null;
  method: string;
  reference: string;
  transactionId?: string | null;
  orderId?: string | null;
  depositedAmount: number;
  depositedCurrency: string;
  creditedAmount: number;
  creditedCurrency: string;
  bonusAmount?: number;
}

function printable(value: string): string {
  // Standard PDF fonts use WinAnsi; keep French/Latin text and replace
  // unsupported symbols rather than failing the payment transaction.
  return value.replace(/[\u00a0\u202f]/g, " ").replace(/[^\u0000-\u00ff]/g, "?");
}

function money(amount: number, currency: string): string {
  const digits = currency === "USD" ? 2 : 0;
  return `${new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: 2,
  }).format(amount)} ${currency}`;
}

function dateLabel(value: string | Date): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Date indisponible";
  return date.toLocaleString("fr-FR", {
    timeZone: "Africa/Douala",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function wrapText(value: string, font: PDFFont, size: number, width: number): string[] {
  const words = printable(value).split(/\s+/).filter(Boolean);
  if (!words.length) return ["—"];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(next, size) > width) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
    if (font.widthOfTextAtSize(line, size) > width) {
      let segment = "";
      for (const character of line) {
        const candidate = segment + character;
        if (segment && font.widthOfTextAtSize(candidate, size) > width) {
          lines.push(segment);
          segment = character;
        } else {
          segment = candidate;
        }
      }
      line = segment;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawTextAtTop(
  page: PDFPage, value: string, x: number, top: number, size: number,
  font: PDFFont, color: ReturnType<typeof rgb>, lineGap = 2,
): number {
  const lines = wrapText(value, font, size, page.getWidth() - x - 44);
  lines.forEach((line, index) => page.drawText(line, {
    x,
    y: page.getHeight() - top - size - index * (size + lineGap),
    size, font, color,
  }));
  return lines.length * (size + lineGap);
}

export async function createDepositInvoiceAttachment(
  input: DepositInvoiceInput,
): Promise<NotificationAttachment> {
  const document = await PDFDocument.create();
  const page = document.addPage([595.28, 841.89]);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const navy = rgb(24 / 255, 34 / 255, 53 / 255);
  const muted = rgb(89 / 255, 98 / 255, 116 / 255);
  const pale = rgb(242 / 255, 245 / 255, 250 / 255);
  const white = rgb(1, 1, 1);
  const ink = rgb(24 / 255, 34 / 255, 53 / 255);
  const pageWidth = page.getWidth();

  page.drawRectangle({ x: 0, y: page.getHeight() - 112, width: pageWidth, height: 112, color: navy });
  page.drawText("BUZZ BOOSTER", {
    x: 44, y: page.getHeight() - 34 - 23, size: 23, font: bold, color: white,
  });
  page.drawText("Services SMM & recharges", {
    x: 44, y: page.getHeight() - 68 - 10, size: 10, font: regular,
    color: rgb(203 / 255, 213 / 255, 232 / 255),
  });
  page.drawText("FACTURE DE DÉPÔT", {
    x: 360, y: page.getHeight() - 46 - 11, size: 11, font: bold, color: white,
  });

  const number = `BP-DEP-${input.id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  let y = 136;
  drawTextAtTop(page, "Reçu de dépôt confirmé", 44, y, 17, bold, ink);
  y += 29;
  drawTextAtTop(page, `N° ${number}     |     ${dateLabel(input.createdAt)}`, 44, y, 9, regular, muted);
  y += 34;

  const details: Array<[string, string]> = [
    ["Client", input.customerName?.trim() || "—"],
    ["E-mail du compte", input.customerEmail?.trim() || "—"],
    ["Méthode de paiement", input.method || "—"],
    ["Référence", input.reference || "—"],
  ];
  if (input.orderId) details.push(["Référence de commande", input.orderId]);
  if (input.transactionId) details.push(["Référence de paiement", input.transactionId]);
  details.push(
    ["Montant du dépôt", money(input.depositedAmount, input.depositedCurrency)],
    ["Montant crédité au portefeuille", money(input.creditedAmount, input.creditedCurrency)],
  );
  if (input.bonusAmount && input.bonusAmount > 0) {
    details.push(["Bonus crédité", money(input.bonusAmount, input.creditedCurrency)]);
  }
  details.push(["Statut", "Confirmé"]);

  const left = 44;
  const width = pageWidth - 88;
  const labelWidth = 175;
  for (const [index, [label, rawValue]] of details.entries()) {
    const labels = wrapText(label, regular, 9, labelWidth - 20);
    const values = wrapText(rawValue, bold, 10, width - labelWidth - 22);
    const rowHeight = Math.max(30, Math.max(labels.length * 11, values.length * 12) + 16);
    page.drawRectangle({
      x: left, y: page.getHeight() - y - rowHeight, width, height: rowHeight,
      color: index % 2 === 0 ? pale : white,
    });
    labels.forEach((line, lineIndex) => page.drawText(line, {
      x: left + 11, y: page.getHeight() - y - 9 - 9 - lineIndex * 11,
      size: 9, font: regular, color: muted,
    }));
    values.forEach((line, lineIndex) => page.drawText(line, {
      x: left + labelWidth, y: page.getHeight() - y - 8 - 10 - lineIndex * 12,
      size: 10, font: bold, color: ink,
    }));
    y += rowHeight;
  }

  y += 24;
  page.drawLine({
    start: { x: 44, y: page.getHeight() - y },
    end: { x: pageWidth - 44, y: page.getHeight() - y },
    thickness: 1, color: rgb(216 / 255, 221 / 255, 230 / 255),
  });
  const footer = "Document généré automatiquement par BUZZ BOOSTER. Conservez-le pour vos archives.";
  const footerLines = wrapText(footer, regular, 8, pageWidth - 88);
  footerLines.forEach((line, index) => page.drawText(line, {
    x: 44, y: page.getHeight() - y - 12 - 8 - index * 10,
    size: 8, font: regular, color: rgb(123 / 255, 132 / 255, 148 / 255),
  }));
  document.setTitle(number);
  document.setAuthor("BUZZ BOOSTER");
  document.setSubject("Facture de dépôt");

  const pdf = Buffer.from(await document.save());
  return {
    filename: `facture-depot-${number}.pdf`,
    type: "application/pdf",
    content: pdf.toString("base64"),
  };
}