// Transactional email templates. Inline styles and table layout for broad client support.
// House style: no em dashes in any email text.
export type TemplateUser = { displayName: string; email: string; createdAt: number };
export type RenderedEmail = { subject: string; html: string; text: string };

export const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// Subjects are single-line headers.
const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
export const formatUtc = (time: number) => {
  const date = new Date(time);
  return `${date.toUTCString().replace(" GMT", "")} UTC (${date.toISOString()})`;
};

const shell = (appUrl: string, title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#f3f5fa;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5fa;padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e3e8f2;font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:#1b2436;">
<tr><td style="padding:26px 32px 20px;border-bottom:1px solid #eef1f7;">
<a href="${appUrl}" style="text-decoration:none;"><img src="${appUrl}/kodelumi-email-logo.png" width="180" height="43" alt="Kodelumi" style="display:block;border:0;width:180px;height:43px;"></a>
</td></tr>
${body}
<tr><td style="padding:18px 32px 26px;border-top:1px solid #eef1f7;font-size:12px;line-height:18px;color:#7a869b;">
Kodelumi &middot; Code &bull; Learn &bull; Create &bull; Share<br><a href="${appUrl}" style="color:#6366f1;text-decoration:none;">${escapeHtml(appUrl.replace(/^https?:\/\//, ""))}</a>
</td></tr>
</table></td></tr></table></body></html>`;

export function welcomeEmail(user: TemplateUser, appUrl: string): RenderedEmail {
  const name = escapeHtml(user.displayName);
  const dashboard = `${appUrl}/workspaces`;
  const html = shell(
    appUrl,
    "Welcome to Kodelumi",
    `<tr><td style="padding:28px 32px 8px;">
<h1 style="margin:0 0 14px;font-size:24px;line-height:32px;color:#1b2436;">Welcome to Kodelumi, ${name}!</h1>
<p style="margin:0 0 14px;font-size:15px;line-height:24px;color:#33405a;">Your account is ready, and we are glad you are here.</p>
<p style="margin:0 0 10px;font-size:15px;line-height:24px;color:#33405a;">With Kodelumi you can:</p>
<ul style="margin:0 0 20px;padding-left:20px;font-size:15px;line-height:24px;color:#33405a;">
<li><strong>Create workspaces</strong> for projects, lessons and technical notes.</li>
<li><strong>Write code</strong> and documentation, live and together.</li>
<li><strong>Share your work</strong> with secure, read-only links that anyone can open.</li>
</ul>
</td></tr>
<tr><td align="left" style="padding:0 32px 28px;">
<a href="${dashboard}" style="display:inline-block;background:#6d5cf2;background-image:linear-gradient(120deg,#7c4ff0,#4f7bf7);color:#ffffff;font-size:15px;font-weight:600;line-height:20px;padding:12px 22px;border-radius:8px;text-decoration:none;">Go to My Workspaces</a>
<p style="margin:18px 0 0;font-size:13px;line-height:20px;color:#7a869b;">You are receiving this email because a Kodelumi account was created with ${escapeHtml(user.email)}. If that was not you, you can reply to let us know.</p>
</td></tr>`,
  );
  const text = [
    `Welcome to Kodelumi, ${user.displayName}!`,
    "",
    "Your account is ready, and we are glad you are here.",
    "",
    "With Kodelumi you can:",
    "- Create workspaces for projects, lessons and technical notes.",
    "- Write code and documentation, live and together.",
    "- Share your work with secure, read-only links that anyone can open.",
    "",
    `Go to My Workspaces: ${dashboard}`,
    "",
    `You are receiving this email because a Kodelumi account was created with ${user.email}. If that was not you, you can reply to let us know.`,
    "",
    "Kodelumi: Code, Learn, Create, Share",
    appUrl,
  ].join("\n");
  return { subject: oneLine(`Welcome to Kodelumi, ${user.displayName}!`), html, text };
}

// Administrator notification: identity and time only, never credentials or session data.
export function adminSignupEmail(user: TemplateUser, appUrl: string): RenderedEmail {
  const when = formatUtc(user.createdAt);
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 12px 6px 0;font-size:14px;color:#7a869b;white-space:nowrap;vertical-align:top;">${label}</td><td style="padding:6px 0;font-size:14px;color:#1b2436;">${value}</td></tr>`;
  const html = shell(
    appUrl,
    "New Kodelumi signup",
    `<tr><td style="padding:28px 32px 26px;">
<h1 style="margin:0 0 14px;font-size:20px;line-height:28px;color:#1b2436;">New user registered</h1>
<table role="presentation" cellpadding="0" cellspacing="0">
${row("Display name", escapeHtml(user.displayName))}
${row("Email", escapeHtml(user.email))}
${row("Registered", escapeHtml(when))}
</table>
</td></tr>`,
  );
  const text = [
    "New user registered on Kodelumi",
    "",
    `Display name: ${user.displayName}`,
    `Email: ${user.email}`,
    `Registered: ${when}`,
    "",
    appUrl,
  ].join("\n");
  return { subject: oneLine(`New Kodelumi signup: ${user.displayName}`), html, text };
}
