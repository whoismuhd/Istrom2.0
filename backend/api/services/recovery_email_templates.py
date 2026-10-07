"""Branded, email-client-friendly administrator account messages."""
from dataclasses import dataclass
from html import escape
from pathlib import Path


# Rasterized from frontend/src/assets/istrom-wordmark.svg, the official logo.
LOGO_PATH = Path(__file__).resolve().parents[1] / 'assets' / 'istrom-email-logo.png'
LOGO_CID = 'istrom-wordmark'


@dataclass(frozen=True)
class RecoveryEmail:
    subject: str
    text: str
    html: str


def _layout(title, preheader, content):
    """Only callers' constant markup belongs in content; escape variable text."""
    return f'''<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>{escape(title)}</title>
  <style>
    @media only screen and (max-width: 600px) {{
      .email-shell {{ padding: 20px 12px !important; }}
      .email-content {{ padding: 28px 24px !important; }}
      .email-header {{ padding: 28px 24px !important; }}
      .email-title {{ font-size: 26px !important; }}
    }}
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f2f4f7;font-family:Arial,Helvetica,sans-serif;color:#182230;">
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">{escape(preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f2f4f7">
    <tr><td align="center" class="email-shell" style="padding:40px 16px;">
      <!--[if mso]><table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;">
        <tr><td bgcolor="#192333" class="email-header" style="padding:32px;border-radius:8px 8px 0 0;">
          <img src="cid:{LOGO_CID}" width="167" height="36" alt="Istrom" style="display:block;width:167px;height:36px;border:0;color:#ffffff;font-size:28px;font-weight:bold;">
          <p style="margin:14px 0 0;font-size:13px;line-height:20px;color:#cbd5e1;">Inventory &amp; budgets</p>
        </td></tr>
        <tr><td bgcolor="#ffffff" class="email-content" style="padding:36px 32px;border:1px solid #e4e7ec;border-top:0;border-radius:0 0 8px 8px;">
          <p style="margin:0 0 12px;font-size:11px;line-height:16px;font-weight:bold;letter-spacing:1.2px;color:#a63c13;">ADMIN ACCOUNT</p>
          <h1 class="email-title" style="margin:0 0 20px;font-size:28px;line-height:36px;font-weight:bold;letter-spacing:-0.6px;color:#182230;">{escape(title)}</h1>
          {content}
        </td></tr>
        <tr><td align="center" style="padding:20px 16px 0;">
          <p style="margin:0;font-size:12px;line-height:18px;color:#667085;">Istrom Group &middot; Account security</p>
        </td></tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>
  </table>
</body>
</html>'''


def _button(url, label):
    return f'''<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:26px 0 20px;">
  <tr><td align="center" bgcolor="#c54f20" style="border:1px solid #c54f20;border-radius:5px;mso-padding-alt:14px 24px;">
    <a href="{escape(url, quote=True)}" style="display:inline-block;padding:14px 24px;font-size:15px;line-height:20px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:5px;">{escape(label)}</a>
  </td></tr>
</table>'''


def reset_email(frontend_url, token):
    # Keep the secret in a fragment, outside server logs and Referrer headers.
    link = f'{frontend_url}/reset-password#token={token}'
    subject = 'Reset your Istrom admin password'
    text = (
        f'Open this link to choose a new admin password:\n\n{link}\n\n'
        'This link expires in 15 minutes and can be used once.\n'
        'If you did not request this, ignore this email. Your password has not changed.\n'
    )
    content = f'''<p style="margin:0;font-size:15px;line-height:24px;color:#475467;">A password reset was requested for <strong style="color:#182230;">Istrom_Admin</strong>.</p>
{_button(link, 'Reset password')}
<p style="margin:0;font-size:13px;line-height:20px;color:#667085;">Valid for 15 minutes &middot; Use once</p>
<p style="margin:22px 0 0;font-size:13px;line-height:21px;color:#667085;">Button not working? <a href="{escape(link, quote=True)}" style="color:#a63c13;text-decoration:underline;">Open the reset page</a>.</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:28px;">
  <tr><td style="border-top:1px solid #e4e7ec;padding-top:22px;">
    <p style="margin:0;font-size:13px;line-height:21px;color:#667085;">If you did not request this, ignore this email. Your password has not changed.</p>
  </td></tr>
</table>'''
    return RecoveryEmail(subject, text, _layout('Reset your password', 'Your Istrom password reset link is valid for 15 minutes.', content))


def password_changed_email(frontend_url):
    link = f'{frontend_url}/login/admin'
    subject = 'Your Istrom admin password was changed'
    text = (
        'Your Istrom admin password was reset. All previous admin sessions have ended.\n'
        f'You can sign in here:\n{link}\n\n'
        'If you did not do this, contact the person managing your hosting account immediately.\n'
    )
    content = f'''<p style="margin:0;font-size:15px;line-height:24px;color:#475467;">The password for <strong style="color:#182230;">Istrom_Admin</strong> has been changed. All previous admin sessions have ended.</p>
{_button(link, 'Sign in')}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:28px;">
  <tr><td style="border-top:1px solid #e4e7ec;padding-top:22px;">
    <p style="margin:0;font-size:13px;line-height:21px;color:#667085;">If you did not do this, contact the person managing your hosting account immediately.</p>
  </td></tr>
</table>'''
    return RecoveryEmail(subject, text, _layout('Password changed', 'Your Istrom admin password has been changed.', content))
