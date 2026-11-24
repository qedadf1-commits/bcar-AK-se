function parseNumericPrice(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number" && !Number.isNaN(value)) return value;
  const str = String(value).trim();
  if (str === "مشمول") return 0;
  const match = str.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : 0;
}

function toSchemaCompanyData(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const items = Array.isArray(raw.options)
    ? raw.options
    : Array.isArray(raw.features)
      ? raw.features
      : [];
  return {
    name: String(raw.name || raw.company || ""),
    nameKey: String(raw.nameKey || ""),
    logo: String(raw.logo || ""),
    price: parseNumericPrice(raw.price),
    options: items.map((item) => ({
      label: String(item.label || item.text || ""),
      labelKey: String(item.labelKey || ""),
      price: parseNumericPrice(item.price),
      checked: Boolean(item.checked ?? item.selected),
    })),
  };
}

module.exports = { toSchemaCompanyData, parseNumericPrice };
