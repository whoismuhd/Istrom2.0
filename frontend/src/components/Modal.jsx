import { useEffect, useRef } from 'react';

export default function Modal({ children, onClose, labelledBy }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => [...dialog.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')]
      .filter((control) => !control.disabled && control.tabIndex >= 0 && control.getClientRects().length > 0);
    const controls = focusable();
    (controls.find((control) => control.matches('input, select, textarea')) || controls[0] || dialog).focus();
    const handleKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const controls = focusable();
      const first = controls[0];
      const last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog || !controls.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    dialog.addEventListener('keydown', handleKey);
    return () => {
      dialog.removeEventListener('keydown', handleKey);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return <div className="modal-overlay" onClick={onClose}>
    <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
      <button type="button" className="modal-close" aria-label="Close dialog" onClick={onClose}>×</button>
      {children}
    </div>
  </div>;
}
