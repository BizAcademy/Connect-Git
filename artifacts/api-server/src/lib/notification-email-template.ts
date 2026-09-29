import logoDataUrl from "../../../bizpanel/src/assets/logo-buzzbooster.png";
import type { NotificationEmail } from "./mailtrap-notification-client";

const logoContent = logoDataUrl.split(",")[1];
if (!logoContent) throw new Error("BUZZ BOOSTER email logo is missing");

export const logoAttachment = {
  content: logoContent,
  filename: "buzz-booster-logo.png",
  type: "image/png",
  disposition: "inline",
  content_id: "buzz-booster-logo",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

const logo = `<img src="cid:buzz-booster-logo" alt="BUZZ BOOSTER" width="220" style="display:block;width:220px;max-width:100%;height:auto;border:0;">`;
const footer = `<p style="margin:0 0 8px;color:#8991a3;font-size:13px;">L'équipe BUZZ BOOSTER</p>
  <p style="margin:0;color:#8991a3;font-size:12px;">Message automatique — ne répondez pas à cet e-mail.</p>`;

function detailsTable(details: Record<string, string> | undefined, dark: boolean): string {
  if (!details || !Object.keys(details).length) return "";
  const border = dark ? "#424b60" : "#d8dde6";
  const muted = dark ? "#a9b4c8" : "#596274";
  const ink = dark ? "#f3f6ff" : "#141b29";
  const rows = Object.entries(details).map(([key, value]) =>
    `<tr><td style="padding:12px 8px 12px 0;color:${muted};font-size:14px;vertical-align:top;">${escapeHtml(key)}</td>
     <td style="padding:12px 0;text-align:right;color:${ink};font-weight:600;font-size:14px;vertical-align:top;word-break:break-word;">${escapeHtml(value)}</td></tr>`,
  ).join("");
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:28px 0;border-top:1px solid ${border};border-bottom:1px solid ${border};border-collapse:collapse;">${rows}</table>`;
}

function securityHtml(input: NotificationEmail): string {
  const title = escapeHtml(input.title);
  const message = escapeHtml(input.otp_code
    ? input.message.replaceAll(input.otp_code, "ci-dessous")
    : input.message);
  const subtitle = input.subtitle ? `<p style="color:#aeb9d1;font-size:15px;">${escapeHtml(input.subtitle)}</p>` : "";
  const callout = input.otp_code
    ? `<div style="margin:28px 0;padding:25px 20px;text-align:center;border:1px dashed #5576da;border-radius:16px;background:#1d2539;">
         <p style="color:#a9bdff;font-size:13px;font-weight:700;margin:0 0 15px;">VOTRE CODE DE VÉRIFICATION</p>
         <p style="color:#ffffff;font-family:monospace;font-size:34px;font-weight:700;letter-spacing:8px;margin:0;">${escapeHtml(input.otp_code)}</p>
         <p style="color:#aeb9d1;font-size:13px;margin:15px 0 0;">Ce code expire dans 10 minutes.</p>
       </div>`
    : input.action_url
      ? `<div style="margin:28px 0;"><a href="${escapeHtml(input.action_url)}" style="display:inline-block;padding:14px 25px;border-radius:10px;background:#246dff;color:#ffffff;text-decoration:none;font-weight:700;">${escapeHtml(input.action_label || "Continuer")}</a></div>
         <p style="color:#aeb9d1;font-size:12px;word-break:break-all;">Si le bouton ne fonctionne pas : <a href="${escapeHtml(input.action_url)}" style="color:#a9bdff;">${escapeHtml(input.action_url)}</a></p>`
      : "";
  const warning = input.otp_code
    ? "Ne partagez jamais ce code. BUZZ BOOSTER ne vous demandera jamais votre code OTP."
    : "Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.";
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="margin:0;padding:24px 12px;background:#0e1018;font-family:Arial,Helvetica,sans-serif;color:#f3f6ff;">
      <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(input.preheader || input.title)}</div>
      <table role="presentation" align="center" width="100%" cellspacing="0" cellpadding="0" style="max-width:580px;background:#161b28;border-radius:18px;overflow:hidden;">
        <tr><td style="padding:22px 28px;background:#246dff;text-align:center;">
          <div style="display:inline-block;padding:10px 18px;border-radius:12px;background:#ffffff;">${logo}</div>
          <p style="margin:14px 0 0;color:#ffffff;font-size:14px;">Votre plateforme de confiance</p>
        </td></tr>
        <tr><td style="padding:34px 30px;">
          <p style="font-size:34px;text-align:center;margin:0 0 12px;" aria-hidden="true">🔐</p>
          <h1 style="font-size:26px;line-height:1.25;text-align:center;color:#97adff;margin:0 0 26px;">${title}</h1>
          <p style="font-size:16px;margin:0 0 14px;color:#ffffff;">Bonjour,</p>
          <p style="font-size:15px;line-height:1.6;color:#c2cada;margin:0;">${message}</p>${subtitle}${callout}
          ${detailsTable(input.details, true)}
          <p style="padding:15px;border-radius:10px;background:#39291b;color:#ffb866;font-size:13px;line-height:1.5;">⚠ Sécurité : ${warning}</p>
          ${input.note ? `<p style="font-size:13px;color:#aeb9d1;line-height:1.5;">${escapeHtml(input.note)}</p>` : ""}
        </td></tr>
        <tr><td style="padding:26px 30px;text-align:center;border-top:1px solid #303849;background:#1c2230;">${logo}<div style="margin-top:14px;">${footer}</div></td></tr>
      </table>
    </body></html>`;
}

function transactionHtml(input: NotificationEmail): string {
  const details = input.details;
  const amount = details?.["Montant crédité"] || details?.["Commission reçue"];
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="margin:0;padding:24px 12px;background:#f3f5f9;font-family:Arial,Helvetica,sans-serif;color:#101725;">
      <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(input.preheader || input.title)}</div>
      <table role="presentation" align="center" width="100%" cellspacing="0" cellpadding="0" style="max-width:580px;background:#ffffff;border-radius:14px;overflow:hidden;">
        <tr><td style="padding:32px 34px 8px;">${logo}</td></tr>
        <tr><td style="padding:22px 34px 34px;">
          <h1 style="font-size:30px;line-height:1.2;letter-spacing:-.6px;margin:0 0 22px;color:#101725;">${escapeHtml(input.title)}${amount ? `<br><span style="color:#246dff;">${escapeHtml(amount)}</span>` : ""}</h1>
          <p style="font-size:16px;line-height:1.65;color:#273142;margin:0;">${escapeHtml(input.message)}</p>
          ${detailsTable(details, false)}
          ${input.note ? `<p style="font-size:14px;color:#596274;line-height:1.6;">${escapeHtml(input.note)}</p>` : ""}
          <p style="font-size:15px;line-height:1.6;margin:32px 0 0;">Cordialement,<br>L'équipe BUZZ BOOSTER</p>
        </td></tr>
        <tr><td style="padding:23px 34px;background:#f6f8fb;border-top:1px solid #e4e8ef;">${footer}</td></tr>
      </table>
    </body></html>`;
}

export function renderNotificationHtml(input: NotificationEmail): string {
  return input.category === "security" ? securityHtml(input) : transactionHtml(input);
}