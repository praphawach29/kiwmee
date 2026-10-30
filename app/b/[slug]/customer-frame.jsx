// Desktop composition only; existing booking flows remain the source of navigation/actions.
export default function CustomerFrame({ shop, managing = false, completed = false, children }) {
  return (
    <div className="customer-workspace">
      <aside className="customer-side" aria-label="ข้อมูลหน้าจอง">
        <a className="customer-brand" href="/" aria-label="Kiwmee หน้าแรก"><img src="/brand/kiwmee-logo.svg" alt="kiwmee" width="145" height="32" /></a>
        <span className="customer-caption">สำหรับลูกค้า</span>
        <div className="customer-shop"><span className="customer-shop-mark" aria-hidden="true">{shop.name?.[0]}</span><strong>{shop.name}</strong><span>จองคิวออนไลน์</span></div>
        <div className="customer-menu-label">การจอง</div>
        <div className="customer-current" aria-current="page">{managing ? "จัดการการจอง" : completed ? "รายละเอียดการจอง" : "จองคิวกับร้าน"}</div>
        {managing ? <a className="customer-new-booking" href={`/b/${shop.slug}`}>จองคิวใหม่</a> : <ol className="customer-journey" aria-label="ขั้นตอนการจอง"><li>เลือกบริการและวันเวลา</li><li>กรอกข้อมูลผู้จอง</li><li>ยืนยันการจอง</li></ol>}
        <div className="customer-side-note"><strong>{managing ? "ดูแลนัดหมายของคุณ" : "เลือกคิวที่เหมาะกับคุณ"}</strong><p>{managing ? "การเลื่อนและยกเลิกเป็นไปตามกติกาของร้าน โปรดเก็บลิงก์การจองนี้เป็นส่วนตัว" : "ตัวเลือกวันและเวลาจะแสดงตามคิวว่างของร้าน ตรวจสอบรายละเอียดก่อนยืนยัน"}</p></div>
      </aside>
      <div className="customer-body"><div className="customer-top"><span>{shop.name}</span><span>{managing ? "การจองของฉัน" : completed ? "รายละเอียดการจอง" : "จองคิวออนไลน์"}</span></div>{children}</div>
    </div>
  );
}
