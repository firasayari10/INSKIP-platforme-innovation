import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

const MARGIN = 8;
const GAP = 2;
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** Élément déclencheur : position du panneau et retour du focus à la fermeture. */
  anchorRef: RefObject<HTMLElement | null>;
  /** `end` : bord droit du panneau sur le bord droit de l'ancre ; `start` : bords gauches alignés. */
  align?: "start" | "end";
  label: string;
  className?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}

/**
 * Panneau flottant sans dépendance : rendu dans `document.body`, position fixe calculée depuis
 * l'ancre, recadré dans la fenêtre, retourné au-dessus s'il manque de place en bas. Se ferme sur
 * Échap, clic à l'extérieur, défilement et redimensionnement ; rend le focus à l'ancre.
 */
export function Popover(props: PopoverProps) {
  return props.open ? <PopoverPanel {...props} /> : null;
}

function PopoverPanel({ onClose, anchorRef, align = "end", label, className, onKeyDown, children }: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Position : calculée avant affichage, recalculée si le contenu change de taille.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const place = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const a = anchor.getBoundingClientRect();
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const maxLeft = window.innerWidth - width - MARGIN;
      const left = Math.max(MARGIN, Math.min(align === "end" ? a.right - width : a.left, maxLeft));
      let top = a.bottom + GAP;
      const above = a.top - GAP - height;
      if (top + height > window.innerHeight - MARGIN && above >= MARGIN) top = above;
      setPosition({ top: Math.max(MARGIN, top), left });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [anchorRef, align]);

  // Premier élément focalisable une fois le panneau visible.
  const visible = position !== null;
  useEffect(() => {
    if (visible) panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [visible]);

  // Fermeture : Échap, clic extérieur, défilement hors du panneau, redimensionnement.
  useEffect(() => {
    const inside = (target: EventTarget | null) => target instanceof Node && !!panelRef.current?.contains(target);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    const onPointer = (e: MouseEvent) => {
      if (inside(e.target)) return;
      if (e.target instanceof Node && anchorRef.current?.contains(e.target)) return; // l'ancre gère elle-même
      closeRef.current();
    };
    const onScroll = (e: Event) => {
      if (!inside(e.target)) closeRef.current();
    };
    const onResize = () => closeRef.current();
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onPointer, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onPointer, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [anchorRef]);

  // Retour du focus à l'ancre si le focus était dans le panneau (ou perdu) à la fermeture.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const anchor = anchorRef.current;
    return () => {
      const active = document.activeElement;
      if (!active || active === document.body || panel?.contains(active)) anchor?.focus();
    };
  }, [anchorRef]);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={
        position
          ? { position: "fixed", top: position.top, left: position.left }
          : { position: "fixed", top: 0, left: 0, visibility: "hidden" }
      }
      className={cn("z-50 rounded-sm border border-border bg-popover p-1 text-ui text-popover-foreground shadow-md", className)}
    >
      {children}
    </div>,
    document.body,
  );
}
