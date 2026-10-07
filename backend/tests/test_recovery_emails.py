"""Check the actionable links and MIME/Resend compatibility of branded emails."""
import base64
from email import policy
from email.parser import BytesParser
from html.parser import HTMLParser
import json

import pytest

from api.services import recovery_mail
from api.services.recovery_email_templates import (
    LOGO_CID, LOGO_PATH, password_changed_email, reset_email,
)


class EmailLinks(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.links, self.images = [], []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'a': self.links.append(attrs['href'])
        if tag == 'img': self.images.append(attrs)


@pytest.mark.parametrize('origin', ['https://app.example.com', 'http://localhost:5173'])
def test_reset_email_links_match_text_and_keep_the_token_in_a_fragment(origin):
    token = 'a' * 43
    email = reset_email(origin, token)
    links = EmailLinks(email.html)
    expected = f'{origin}/reset-password#token={token}'
    assert links.links == [expected, expected]
    assert expected in email.text and '?token=' not in email.text + email.html
    assert '15 minutes' in email.text + email.html
    assert 'Your password has not changed.' in email.text and 'Your password has not changed.' in email.html
    assert links.images[0]['alt'] == 'Istrom'
    assert links.images[0]['src'] == f'cid:{LOGO_CID}'
    assert 'https://' not in links.images[0]['src']


def test_url_values_are_escaped_in_html_attributes():
    token = 'preview"&<not-a-real-token>'
    email = reset_email('https://app.example.com', token)
    assert 'preview"&<' not in email.html
    assert EmailLinks(email.html).links == [f'https://app.example.com/reset-password#token={token}'] * 2


def test_changed_email_points_to_admin_signin_without_a_reset_link():
    email = password_changed_email('https://app.example.com')
    assert EmailLinks(email.html).links == ['https://app.example.com/login/admin']
    assert 'https://app.example.com/login/admin' in email.text
    assert '#token=' not in email.text + email.html
    assert 'All previous admin sessions have ended.' in email.text and 'All previous admin sessions have ended.' in email.html


@pytest.mark.parametrize('make_email', [lambda: reset_email('https://app.example.com', 'a' * 43),
    lambda: password_changed_email('https://app.example.com')])
def test_smtp_contains_text_html_and_the_logo_as_a_related_inline_image(monkeypatch, make_email):
    config = recovery_mail.RecoveryMailConfig('owner@example.com', 'https://app.example.com',
        'mail@example.com', 'smtp', host='smtp.example.com', username='mailer', password='test-only')
    captured = []
    class Transport:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def ehlo(self): pass
        def starttls(self, context): pass
        def login(self, *args): pass
        def send_message(self, message): captured.append(message.as_bytes())
    monkeypatch.setattr(recovery_mail.smtplib, 'SMTP', lambda *args, **kwargs: Transport())
    email = make_email()
    recovery_mail.send_mail(config, email.subject, email.text, html=email.html)
    message = BytesParser(policy=policy.default).parsebytes(captured[0])
    assert message['From'].addresses[0].display_name == 'Istrom'
    assert message['To'].addresses[0].addr_spec == config.recipient
    assert message.get_content_type() == 'multipart/alternative'
    assert message.get_body(('plain',)).get_content() == email.text
    assert message.get_body(('html',)).get_content().rstrip() == email.html
    related = message.get_payload()[-1]
    assert related.get_content_type() == 'multipart/related'
    image = related.get_payload()[1]
    assert image.get_content_type() == 'image/png'
    assert image['Content-ID'] == f'<{LOGO_CID}>'
    assert image.get_content_disposition() == 'inline'
    assert image.get_payload(decode=True) == LOGO_PATH.read_bytes()
    assert image.get_payload(decode=True).startswith(b'\x89PNG\r\n\x1a\n')


def test_resend_receives_both_versions_and_matching_embedded_logo(monkeypatch):
    config = recovery_mail.RecoveryMailConfig('owner@example.com', 'https://app.example.com',
        'onboarding@resend.dev', 'resend', api_key='re_test_only')
    captured = []
    class Transport:
        status = 200
        def __init__(self, *args, **kwargs): pass
        def request(self, method, path, body, headers): captured.append(json.loads(body))
        def getresponse(self): return self
        def read(self, limit): return b'{"id":"test-message"}'
        def close(self): pass
    monkeypatch.setattr(recovery_mail.http.client, 'HTTPSConnection', Transport)
    email = reset_email(config.frontend_url, 'a' * 43)
    recovery_mail.send_mail(config, email.subject, email.text, html=email.html)
    mail = captured[0]
    assert mail['from'] == 'Istrom <onboarding@resend.dev>' and mail['to'] == [config.recipient]
    assert mail['text'] == email.text and mail['html'] == email.html
    assert len(mail['attachments']) == 1
    logo = mail['attachments'][0]
    assert EmailLinks(mail['html']).images[0]['src'] == f"cid:{logo['content_id']}"
    assert logo['content_type'] == 'image/png' and logo['filename'].endswith('.png')
    assert base64.b64decode(logo['content'], validate=True) == LOGO_PATH.read_bytes()
