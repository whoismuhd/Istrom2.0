import './Logo.css';

export default function Logo({ className = '' }) {
  return (
    <span className={`istrom-logo ${className}`}>
      I<span className="logo-str">str</span>
      <span className="logo-o">o</span>
      <span className="logo-m">m</span>
    </span>
  );
}
