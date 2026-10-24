// A small drop-down menu in the app's own style, used instead of a native <select> whose open list is
// drawn by the browser and the system (a macOS menu in Safari and Chrome, something else elsewhere).
// Follows the WAI-ARIA menu button pattern: arrow keys, Home, End, Enter, Space, Escape, Tab, and a
// click outside closes it.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export interface MenuItem {
  key: string;
  label: ReactNode;
  /** Tooltip, for a detail that would crowd the menu (a vault's folder). */
  title?: string;
  /** Shown with a check mark, for the current choice. */
  checked?: boolean;
  /** Draw a divider above this item. */
  separated?: boolean;
  onSelect: () => void;
}

interface Props {
  /** What the closed button shows. */
  button: ReactNode;
  /** Accessible name of the button, including the current choice ("Vault: Second Brain"), and its tooltip unless `title` is given. */
  label: string;
  title?: string;
  className?: string;
  items: MenuItem[];
}

export function Menu({ button, label, title, className, items }: Props) {
  // The item to focus while open (the current choice, or the first item); null when closed.
  const [openAt, setOpenAt] = useState<number | null>(null);
  const open = openAt !== null;
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const hasChecks = items.some((i) => i.checked !== undefined);

  const focusItem = (i: number) => itemRefs.current[(i + items.length) % items.length]?.focus();
  const openMenu = () => setOpenAt(Math.max(0, items.findIndex((i) => i.checked)));
  const close = (refocus: boolean) => {
    setOpenAt(null);
    if (refocus) buttonRef.current?.focus();
  };

  // On opening, focus the chosen item; a click outside closes.
  useEffect(() => {
    if (openAt === null) return;
    itemRefs.current[openAt]?.focus();
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpenAt(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [openAt]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const at = itemRefs.current.findIndex((el) => el === document.activeElement);
    if (e.key === "ArrowDown") focusItem(at + 1);
    else if (e.key === "ArrowUp") focusItem(at - 1);
    else if (e.key === "Home") focusItem(0);
    else if (e.key === "End") focusItem(items.length - 1);
    else if (e.key === "Escape") close(true);
    else if (e.key === "Tab") return close(false);
    else return;
    e.preventDefault();
  };

  return (
    <div className="menu" ref={wrapRef}>
      <button
        ref={buttonRef}
        id={`${id}-button`}
        type="button"
        className={className}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        title={title ?? label}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            openMenu();
          }
        }}
      >
        {button}
        <svg className="menu-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="menu-panel" role="menu" id={id} aria-labelledby={`${id}-button`} onKeyDown={onMenuKey}>
          {items.map((item, i) => (
            <button
              key={item.key}
              ref={(el) => void (itemRefs.current[i] = el)}
              type="button"
              role={item.checked === undefined ? "menuitem" : "menuitemradio"}
              aria-checked={item.checked}
              tabIndex={-1}
              title={item.title}
              className={`menu-item${item.separated ? " separated" : ""}${item.checked ? " checked" : ""}`}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
            >
              {hasChecks && (
                <span className="menu-check" aria-hidden="true">
                  {item.checked ? "✓" : ""}
                </span>
              )}
              <span className="menu-label">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
