(function () {
  function create() {
    return window.LocalServiceClient.create(window.APP_RUNTIME || {});
  }

  window.AppServiceClient = {create};
})();
