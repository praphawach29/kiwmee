import { TEXT_ZOOM_SCRIPT } from "./text-zoom.mjs";

// Every customer page (/b/...): undo LINE's own text zoom on Android before anything paints
export default function CustomerLayout({ children }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: TEXT_ZOOM_SCRIPT }} />
      {children}
    </>
  );
}
