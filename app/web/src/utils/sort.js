(function () {
  const collator = new Intl.Collator('zh-Hans-CN', {sensitivity: 'base', numeric: true});

  function normalizeName(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function compareNames(left, right) {
    return collator.compare(normalizeName(left), normalizeName(right));
  }

  function sortByName(items, pick) {
    const read = typeof pick === 'function' ? pick : (item) => item?.name;
    return [...(items || [])].sort((left, right) => compareNames(read(left), read(right)));
  }

  window.SortUtils = {compareNames, sortByName, normalizeName};
})();
