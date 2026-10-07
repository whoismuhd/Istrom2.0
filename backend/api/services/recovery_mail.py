"""Private email configuration and administrator recovery mail."""
from dataclasses import dataclass, field
from email.message import EmailMessage
from email.utils import formataddr
import base64
import hashlib
import http.client
import json
import logging
import os
import re
import smtplib
import ssl
from urllib.parse import urlsplit
import certifi

from api.settings import ALLOWED_ORIGINS
from api.services.recovery_email_templates import (
    LOGO_CID, LOGO_PATH, password_changed_email, reset_email,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RecoveryMailConfig:
    recipient: str
    frontend_url: str
    sender: str
    provider: str
    api_key: str = field(default='', repr=False)
    host: str = ''
    port: int = 587
    security: str = 'starttls'
    username: str = ''
    password: str = field(default='', repr=False)

    @property
    def recipient_hash(self):
        return hashlib.sha256(self.recipient.lower().encode('utf-8')).hexdigest()


def get_recovery_config():
    """Fail closed until all mail settings and the trusted frontend are ready."""
    values = {key: os.getenv(key, '').strip() for key in (
        'ADMIN_RECOVERY_EMAIL', 'APP_FRONTEND_URL', 'SMTP_HOST', 'SMTP_USERNAME',
        'SMTP_FROM', 'SMTP_SECURITY', 'SMTP_PORT',
        'ADMIN_RECOVERY_PROVIDER', 'RESEND_FROM',
    )}
    email_pattern = r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}"
    provider = values['ADMIN_RECOVERY_PROVIDER'] or 'resend'
    sender = values['RESEND_FROM'] if provider == 'resend' else values['SMTP_FROM']
    if not all(re.fullmatch(email_pattern, value) and len(value) <= 254
               for value in (values['ADMIN_RECOVERY_EMAIL'], sender)):
        return None
    try:
        url = urlsplit(values['APP_FRONTEND_URL'])
        # Check URL parsing, including invalid ports and bracketed hosts.
        url.port
    except ValueError:
        return None
    origin = values['APP_FRONTEND_URL'].rstrip('/')
    local = url.hostname in ('localhost', '127.0.0.1', '::1')
    if (origin not in ALLOWED_ORIGINS or url.username or url.password or
            url.path not in ('', '/') or url.query or url.fragment or
            not (url.scheme == 'https' or (local and url.scheme == 'http'))):
        return None
    if provider == 'resend':
        api_key = os.getenv('RESEND_API_KEY', '')
        if len(api_key) < 16 or any(char.isspace() for char in api_key):
            return None
        return RecoveryMailConfig(recipient=values['ADMIN_RECOVERY_EMAIL'], frontend_url=origin,
            sender=sender, provider=provider, api_key=api_key)
    if provider != 'smtp':
        return None
    password = os.getenv('SMTP_PASSWORD', '')
    if not all(values[key] for key in ('SMTP_HOST', 'SMTP_USERNAME')) or not password:
        return None
    if any(char.isspace() for char in values['SMTP_HOST']):
        return None
    try:
        port = int(values['SMTP_PORT'] or '587')
    except ValueError:
        return None
    security = values['SMTP_SECURITY'] or 'starttls'
    if security not in ('starttls', 'ssl') or not 1 <= port <= 65535:
        return None
    return RecoveryMailConfig(recipient=values['ADMIN_RECOVERY_EMAIL'], frontend_url=origin,
        sender=sender, provider=provider, host=values['SMTP_HOST'], port=port,
        security=security, username=values['SMTP_USERNAME'], password=password)


def send_mail(config, subject, body, *, html=None):
    sender = formataddr(('Istrom', config.sender))
    # A bundled inline image works without a public image host or tracking URL.
    logo = LOGO_PATH.read_bytes() if html is not None else None
    # Python installations on macOS may have no default CA bundle. Keep
    # certificate and hostname checks enabled with a portable trusted bundle.
    context = ssl.create_default_context(cafile=certifi.where())
    if config.provider == 'resend':
        # Fixed HTTPS destination; never follow redirects with the private API key.
        connection = http.client.HTTPSConnection('api.resend.com', timeout=10, context=context)
        try:
            mail = {'from': sender, 'to': [config.recipient], 'subject': subject, 'text': body}
            if html is not None:
                mail['html'] = html
                mail['attachments'] = [{
                    'content': base64.b64encode(logo).decode('ascii'),
                    'filename': 'istrom-logo.png', 'content_type': 'image/png', 'content_id': LOGO_CID,
                }]
            connection.request('POST', '/emails', body=json.dumps(mail).encode('utf-8'), headers={
                'Authorization': f'Bearer {config.api_key}', 'Content-Type': 'application/json',
                'User-Agent': 'Istrom/1.0',
            })
            response = connection.getresponse()
            payload = response.read(65536)
            if response.status != 200:
                raise OSError('Email provider rejected the message.')
            try:
                result = json.loads(payload)
            except (ValueError, UnicodeError):
                raise OSError('Email provider returned an invalid response.') from None
            if not isinstance(result, dict) or not isinstance(result.get('id'), str) or not result['id']:
                raise OSError('Email provider did not accept the message.')
        except http.client.HTTPException:
            raise OSError('Email provider connection failed.') from None
        finally:
            connection.close()
        return
    message = EmailMessage()
    message['Subject'] = subject
    message['From'] = sender
    message['To'] = config.recipient
    message.set_content(body)
    if html is not None:
        message.add_alternative(html, subtype='html')
        message.get_payload()[-1].add_related(logo, maintype='image', subtype='png',
            cid=f'<{LOGO_CID}>', filename='istrom-logo.png', disposition='inline')
    if config.security == 'ssl':
        connection = smtplib.SMTP_SSL(config.host, config.port, timeout=10, context=context)
    else:
        connection = smtplib.SMTP(config.host, config.port, timeout=10)
    with connection as smtp:
        if config.security == 'starttls':
            smtp.ehlo()
            smtp.starttls(context=context)
            smtp.ehlo()
        smtp.login(config.username, config.password)
        smtp.send_message(message)


def send_reset_link(config, token):
    email = reset_email(config.frontend_url, token)
    send_mail(config, email.subject, email.text, html=email.html)


def notify_password_reset(config):
    try:
        email = password_changed_email(config.frontend_url)
        send_mail(config, email.subject, email.text, html=email.html)
    except (OSError, ValueError):
        # Provider errors can contain credentials, recipients or message data.
        logger.error('Admin password reset notification could not be delivered.')
