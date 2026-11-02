// The customer's page around every booking step: a brand band, the shop's own content, and on wide
// screens an optional summary column. The booking flow stays the source of navigation and actions.
export default function CustomerFrame({ aside = null, children }) {
  return (
    <div className="customer-workspace" data-has-aside={Boolean(aside)}>
      <div className="customer-cover" aria-hidden="true" />
      <div className="customer-layout">
        {children}
        {aside && <aside className="customer-aside" aria-label="สรุปการจอง">{aside}</aside>}
      </div>
    </div>
  );
}
