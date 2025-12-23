# Harmonic Explorer (Dissonance) — Design Language Summary

## Design Intent
A high-density, expert-oriented data interface optimized for real-time blockchain analysis. The UI prioritizes precision, throughput, and composability over approachability or abstraction.

---

## Visual Foundation
- **Theme**: Dark-first (near-black base) to reduce glare and emphasize data contrast.
- **Elevation**: Minimal, achieved via subtle shadowing and luminance shifts rather than borders.
- **Surface Differentiation**: Cards and panels are separated by contrast gradients, not outlines.

---

## Typography
- **Primary Fonts**: Clean sans-serif for labels and UI chrome.
- **Data Fonts**: Hashes, signatures, slots, and numeric values rendered in highly legible, compact styles (often semi- or fully monospaced).
- **Hierarchy**:
  - Labels: low contrast, de-emphasized
  - Values: higher contrast, primary visual focus
- **Density**: Small font sizes tolerated intentionally to maximize information per viewport.

---

## Color System
Color is semantic and invariant across the application.

- **Green**: Successful transactions / inclusion
- **Red**: Failed transactions / errors
- **Purple**: Jito / MEV-related activity
- **Gray**: Votes, background processes, neutral metadata

No decorative or gradient-based color usage; color strictly encodes state or category.

---

## Layout & Information Architecture
- **Grid-Based Modular Layout**:
  - Distinct panels for Block Info, Transactions, Fees, Compute Units.
  - Panels designed to be read independently or in parallel.
- **Vertical Flow**:
  - High-level block metrics at top.
  - Aggregate analytics (charts) in the middle.
  - Per-transaction details and inspection at the bottom.
- **No Progressive Disclosure Bias**:
  - Advanced data is visible by default, not hidden behind “advanced” toggles.

---

## Data Visualization
- **Charts**:
  - High-density bar charts with minimal ornamentation.
  - Raw distributions preferred over smoothed or aggregated visuals.
  - User-controlled normalization (e.g., equal width) rather than enforced scaling.
- **Legends**:
  - Consistent color mapping across charts and tables.
  - Designed to become redundant through repeated exposure.

---

## Tables & Lists
- **Row Density**: Thin rows, minimal padding.
- **Columns**: Numeric and categorical data presented inline without truncation where possible.
- **Status Encoding**:
  - Textual status badges supplemented by color.
- **Interaction**:
  - Inline search, pagination, and row-level affordances are present but visually minimized.

---

## Interaction Model
- **Utility-First Controls**:
  - Search, filters, and navigation prioritized over secondary UI.
- **Filtering**:
  - Supports account-touch filtering to isolate transactions by account participation.
  - Designed for causal and relational analysis, not summary browsing.
- **State Visibility**:
  - Current view state (filters, block index, pagination) always explicit.

---

## UX Assumptions
- Assumes technical proficiency and domain knowledge.
- Optimized for analysts, traders, and infrastructure engineers.
- Avoids explanatory copy, onboarding flows, or simplified abstractions.
- Prefers exposure of raw metrics over interpretive summaries.

---

## Overall Characteristics
- High information density
- Semantic consistency
- Minimal visual noise
- Deterministic, non-opinionated presentation
- Designed for sustained analytical use rather than casual inspection

