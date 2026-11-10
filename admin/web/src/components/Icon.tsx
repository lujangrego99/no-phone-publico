// Íconos pixelarticons (MIT), inline para heredar el color del texto.
import alert from "pixelarticons/svg/warning-diamond.svg?raw";
import check from "pixelarticons/svg/check.svg?raw";
import close from "pixelarticons/svg/close.svg?raw";
import reload from "pixelarticons/svg/reload.svg?raw";
import trash from "pixelarticons/svg/trash.svg?raw";
import pause from "pixelarticons/svg/pause.svg?raw";
import play from "pixelarticons/svg/play.svg?raw";
import logout from "pixelarticons/svg/logout.svg?raw";
import android from "pixelarticons/svg/android.svg?raw";
import search from "pixelarticons/svg/search.svg?raw";
import eye from "pixelarticons/svg/eye.svg?raw";
import phone from "pixelarticons/svg/phone-call.svg?raw";
import mic from "pixelarticons/svg/mic.svg?raw";
import bell from "pixelarticons/svg/bell.svg?raw";
import send from "pixelarticons/svg/send.svg?raw";
import menu from "pixelarticons/svg/menu.svg?raw";
import sliders from "pixelarticons/svg/sliders.svg?raw";
import plus from "pixelarticons/svg/plus.svg?raw";
import pencil from "pixelarticons/svg/pencil.svg?raw";
import more from "pixelarticons/svg/more-horizontal.svg?raw";
import message from "pixelarticons/svg/message.svg?raw";
import user from "pixelarticons/svg/user.svg?raw";
import users from "pixelarticons/svg/users.svg?raw";
import clock from "pixelarticons/svg/clock.svg?raw";
import info from "pixelarticons/svg/info-box.svg?raw";
import back from "pixelarticons/svg/arrow-left.svg?raw";
import target from "pixelarticons/svg/target.svg?raw";
import sparkles from "pixelarticons/svg/sparkles.svg?raw";
import book from "pixelarticons/svg/book-open.svg?raw";
import lock from "pixelarticons/svg/lock.svg?raw";
import inbox from "pixelarticons/svg/inbox.svg?raw";
import chevronDown from "pixelarticons/svg/chevron-down.svg?raw";
import chevronRight from "pixelarticons/svg/chevron-right.svg?raw";
import zap from "pixelarticons/svg/zap.svg?raw";
import wallet from "pixelarticons/svg/wallet.svg?raw";
import settings from "pixelarticons/svg/settings-cog.svg?raw";

const ICONS = {
  alert,
  check,
  close,
  reload,
  trash,
  pause,
  play,
  logout,
  android,
  search,
  eye,
  phone,
  mic,
  bell,
  send,
  menu,
  sliders,
  plus,
  pencil,
  more,
  message,
  user,
  users,
  clock,
  info,
  back,
  target,
  sparkles,
  book,
  lock,
  inbox,
  chevronDown,
  chevronRight,
  zap,
  wallet,
  settings,
};
export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16, label }: { name: IconName; size?: number; label?: string }) {
  const svg = ICONS[name]
    .replace(/\swidth="\d+"/, ` width="${size}"`)
    .replace(/\sheight="\d+"/, ` height="${size}" focusable="false"`);
  return (
    <span
      className="icon"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ display: "inline-flex", width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
