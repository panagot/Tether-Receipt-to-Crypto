import { useId } from "react";

/**
 * Inline comic-panel hero art — tilted receipt + phone, scan sweep, no raster assets.
 */
export function ComicHeroIllustration() {
  const raw = useId();
  const sid = raw.replace(/:/g, "");

  return (
    <figure className="comic-figure" aria-hidden="true">
      <svg className="comic-svg" viewBox="0 0 460 278" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id={`${sid}-panel`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#fffef5" />
            <stop offset="55%" stopColor="#fefce8" />
            <stop offset="100%" stopColor="#fff7ed" />
          </linearGradient>
          <linearGradient id={`${sid}-beam`} x1="0%" y1="50%" x2="100%" y2="50%">
            <stop offset="0%" stopColor="#0d4a6e" stopOpacity="0.12" />
            <stop offset="50%" stopColor="#22c55e" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#0d4a6e" stopOpacity="0.08" />
          </linearGradient>
          <radialGradient id={`${sid}-coinOuter`} cx="32%" cy="22%" r="92%">
            <stop offset="0%" stopColor="#86efac" />
            <stop offset="40%" stopColor="#4ade80" />
            <stop offset="100%" stopColor="#16a34a" />
          </radialGradient>
          <radialGradient id={`${sid}-coinInner`} cx="35%" cy="28%" r="78%">
            <stop offset="0%" stopColor="#34d399" />
            <stop offset="55%" stopColor="#26a17b" />
            <stop offset="100%" stopColor="#0f766e" />
          </radialGradient>
          <filter id={`${sid}-ink`} x="-8%" y="-8%" width="116%" height="116%">
            <feDropShadow dx="0" dy="3" stdDeviation="0" floodColor="#0f1419" floodOpacity="0.12" />
          </filter>
          <clipPath id={`${sid}-receipt-clip`}>
            <path d="M 12 8 L 12 162 L 140 162 L 140 8 L 126 0 L 112 8 L 98 0 L 84 8 L 70 0 L 56 8 L 42 0 L 28 8 Z" />
          </clipPath>
        </defs>

        {/* comic panel frame */}
        <rect
          x="14"
          y="10"
          width="432"
          height="258"
          rx="10"
          fill={`url(#${sid}-panel)`}
          stroke="#0f1419"
          strokeWidth="3"
        />
        <rect
          x="22"
          y="18"
          width="416"
          height="242"
          rx="6"
          fill="none"
          stroke="#0f1419"
          strokeWidth="1.5"
          opacity="0.2"
        />

        {/* speed lines (behind props) */}
        <g opacity="0.07" stroke="#0d4a6e" strokeWidth="2" strokeLinecap="round">
          <line x1="380" y1="32" x2="420" y2="88" />
          <line x1="392" y1="28" x2="432" y2="72" />
          <line x1="368" y1="48" x2="408" y2="110" />
        </g>

        <ellipse cx="230" cy="248" rx="150" ry="11" fill="#0f1419" opacity="0.055" />

        {/* receipt (local space then rotated) */}
        <g transform="translate(58, 44)" filter={`url(#${sid}-ink)`}>
          <g transform="rotate(5.5 76 85)">
            <g clipPath={`url(#${sid}-receipt-clip)`}>
              <path
                d="M 12 8 L 12 162 L 140 162 L 140 8 L 126 0 L 112 8 L 98 0 L 84 8 L 70 0 L 56 8 L 42 0 L 28 8 Z"
                fill="#ffffff"
                stroke="#0f1419"
                strokeWidth="2.5"
                strokeLinejoin="round"
              />
              <rect x="26" y="20" width="100" height="5" rx="2" fill="#e2e6ea" />
              <rect x="26" y="34" width="76" height="5" rx="2" fill="#e2e6ea" />
              <rect x="26" y="48" width="92" height="5" rx="2" fill="#e2e6ea" />
              <rect x="26" y="60" width="68" height="5" rx="2" fill="#e2e6ea" />
              {/* barcode */}
              <g transform="translate(26, 74)">
                {[
                  0, 3, 7, 10, 14, 17, 20, 24, 28, 31, 35, 38, 42, 45, 48, 52, 56, 60, 64, 68, 72, 76, 80, 84,
                  88, 92,
                ].map((x, i) => (
                  <rect
                    key={x}
                    x={x}
                    y={0}
                    width={i % 4 === 0 ? 2.2 : 1.4}
                    height={22}
                    fill="#0f1419"
                    opacity={0.75 + (i % 5) * 0.04}
                  />
                ))}
              </g>
              <rect x="26" y="108" width="56" height="13" rx="3" fill="#fde68a" stroke="#0f1419" strokeWidth="2" />
              <text
                x="30"
                y="118"
                fontSize="10"
                fontWeight="800"
                fill="#0f1419"
                fontFamily="system-ui, sans-serif"
              >
                TOTAL DUE
              </text>
              <rect x="26" y="128" width="84" height="8" rx="2" fill="#bbf7d0" />
              <rect x="26" y="144" width="70" height="5" rx="2" fill="#e2e6ea" />
              {/* scan highlight */}
              <g>
                <animateTransform
                  attributeName="transform"
                  type="translate"
                  values="0,0; 0,118; 0,0"
                  keyTimes="0;0.52;1"
                  dur="2.85s"
                  repeatCount="indefinite"
                  calcMode="spline"
                  keySplines="0.4 0 0.2 1; 0.4 0 0.2 1"
                />
                <rect x="22" y="14" width="108" height="11" rx="3" fill="#86efac" opacity="0.55" />
                <line x1="22" y1="19" x2="130" y2="19" stroke="#22c55e" strokeWidth="1.5" opacity="0.9" />
              </g>
            </g>
            {/* viewfinder (outside clip so corners show) */}
            <g fill="none" stroke="#0d4a6e" strokeWidth="2.5" strokeLinecap="square">
              <path d="M 28 18 h 16 M 28 18 v 16" />
              <path d="M 124 18 h -16 M 124 18 v 16" />
              <path d="M 28 154 h 16 M 28 154 v 14" />
              <path d="M 124 154 h -16 M 124 154 v 14" />
            </g>
          </g>
        </g>

        {/* beam from phone to receipt */}
        <path
          d="M 268 92 L 198 108 L 198 188 L 268 168 Z"
          fill={`url(#${sid}-beam)`}
          stroke="#0d4a6e"
          strokeWidth="2"
          strokeDasharray="5 5"
          opacity="0.9"
        />

        {/* smartphone */}
        <g transform="translate(252, 36)" filter={`url(#${sid}-ink)`}>
          <g transform="rotate(-11 44 78)">
            <rect
              x="0"
              y="0"
              width="88"
              height="158"
              rx="14"
              fill="#1e293b"
              stroke="#0f1419"
              strokeWidth="2.5"
            />
            <rect x="5" y="10" width="6" height="22" rx="2" fill="#334155" stroke="#0f1419" strokeWidth="1.5" />
            <rect x="8" y="22" width="72" height="128" rx="7" fill="#f0f9ff" stroke="#0f1419" strokeWidth="2" />
            <rect x="32" y="14" width="24" height="5" rx="2.5" fill="#0f1419" />
            {/* glass glint */}
            <path
              d="M 16 28 L 28 28 L 22 120 L 16 120 Z"
              fill="#ffffff"
              opacity="0.35"
            />
            {/* USDT — two-layer Tether-style disc + vector mark (no font fallback for ₮) */}
            <g className="comic-coin">
              <circle
                cx="44"
                cy="69"
                r="29"
                fill={`url(#${sid}-coinOuter)`}
                stroke="#0f1419"
                strokeWidth="2.5"
              />
              <circle cx="44" cy="69" r="21.5" fill={`url(#${sid}-coinInner)`} />
              <circle
                cx="44"
                cy="69"
                r="21.5"
                fill="none"
                stroke="#ffffff"
                strokeWidth="0.9"
                opacity="0.28"
              />
              <ellipse
                cx="37.5"
                cy="61"
                rx="11"
                ry="7.5"
                fill="#ffffff"
                opacity="0.22"
                transform="rotate(-28 37.5 61)"
              />
              {/* White T + mid bar (Tether-style), centered on disc */}
              <g
                transform="translate(44, 66.5)"
                fill="#ffffff"
                stroke="none"
                strokeLinejoin="round"
                strokeLinecap="round"
              >
                <rect x="-10" y="-11.5" width="20" height="4" rx="1.2" />
                <rect x="-2.1" y="-11.5" width="4.2" height="21" rx="1.4" />
                <rect x="-8.5" y="-1.2" width="17" height="4" rx="2" />
              </g>
              <rect
                x="20"
                y="86"
                width="48"
                height="16"
                rx="8"
                fill="#ffffff"
                stroke="#0f1419"
                strokeWidth="2"
              />
              <text
                x="44"
                y="97.5"
                textAnchor="middle"
                fontSize="9.5"
                fontWeight="800"
                fill="#0f1419"
                fontFamily="system-ui, sans-serif"
                letterSpacing="0.08em"
              >
                USDT
              </text>
            </g>
            <g>
              <rect x="20" y="124" width="48" height="20" rx="8" fill="#ea580c" stroke="#0f1419" strokeWidth="2" />
              <text
                x="44"
                y="138.5"
                textAnchor="middle"
                fontSize="9.5"
                fontWeight="800"
                fill="#ffffff"
                fontFamily="system-ui, sans-serif"
                letterSpacing="0.12em"
              >
                SEND
              </text>
            </g>
          </g>
        </g>

        {/* burst + motion */}
        <g stroke="#0f1419" strokeWidth="2" strokeLinecap="round">
          <path d="M 388 52 l 10 -8 M 400 42 l 8 -12 M 392 62 l 14 -5" />
          <path d="M 36 88 l -12 -5 M 28 98 l -14 2 M 40 108 l -16 8" />
        </g>
        <polygon points="378,40 384,52 372,48" fill="#fde047" stroke="#0f1419" strokeWidth="1.8" />
        <circle cx="396" cy="32" r="4" fill="#fde047" stroke="#0f1419" strokeWidth="2" />
        <circle cx="48" cy="68" r="5" fill="#93c5fd" stroke="#0f1419" strokeWidth="2" />

        {/* speech bubbles */}
        <g>
          <path
            d="M 312 22 L 402 22 Q 414 22 414 34 L 414 50 Q 414 62 402 62 L 340 62 L 328 72 L 330 62 L 312 62 Q 300 62 300 50 L 300 34 Q 300 22 312 22 Z"
            fill="#ffffff"
            stroke="#0f1419"
            strokeWidth="2.5"
          />
          <text
            x="357"
            y="48"
            textAnchor="middle"
            className="comic-bubble-text"
            fontSize="11"
            fontWeight="600"
            fill="#0f1419"
            fontStyle="italic"
          >
            Scan → pay
          </text>
        </g>
        <g>
          <path
            d="M 24 188 L 118 188 Q 130 188 130 200 L 130 216 Q 130 228 118 228 L 44 228 L 34 238 L 36 228 L 24 228 Q 12 228 12 216 L 12 200 Q 12 188 24 188 Z"
            fill="#ffffff"
            stroke="#0f1419"
            strokeWidth="2.5"
          />
          <text
            x="71"
            y="214"
            textAnchor="middle"
            className="comic-bubble-text"
            fontSize="11"
            fontWeight="600"
            fill="#0f1419"
            fontStyle="italic"
          >
            Pay in USDT
          </text>
        </g>
      </svg>
    </figure>
  );
}
