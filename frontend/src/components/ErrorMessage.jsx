export default function ErrorMessage({ error }) {
  if (!error) return null;
  return <div className="alert alert-danger" role="alert">{error.message || String(error)}</div>;
}
