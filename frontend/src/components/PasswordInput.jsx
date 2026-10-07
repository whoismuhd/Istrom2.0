import { useState } from 'react';

export default function PasswordInput({ id, label, ...props }) {
  const [visible, setVisible] = useState(false);
  return <div className="form-group">
    <label htmlFor={id}>{label}</label>
    <div className="password-input-wrap">
      <input {...props} id={id} type={visible ? 'text' : 'password'} />
      <button type="button" className="btn-toggle-password" disabled={props.disabled} aria-label={`${visible ? 'Hide' : 'Show'} ${label.toLowerCase()}`} onClick={() => setVisible(!visible)}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />{visible && <path d="m3 3 18 18" />}</svg>
      </button>
    </div>
  </div>;
}
