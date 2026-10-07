import './Logo.css';

export default function Logo({ className = '' }) {
  return (
    <span className={`istrom-logo ${className}`} role="img" aria-label="ISTROM" />
  );
}
