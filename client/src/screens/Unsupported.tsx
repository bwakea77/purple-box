export default function Unsupported(): JSX.Element {
  return (
    <div className="screen">
      <div className="brand">Purple Box</div>
      <h1>Unsupported browser</h1>
      <p className="hint-text">
        Purple Box needs a newer browser to run securely. Please update Chrome, Safari, Firefox, or Samsung
        Internet to a recent version.
      </p>
    </div>
  );
}
