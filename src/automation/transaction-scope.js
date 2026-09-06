// Compose existing services inside one outer transaction without opening another connection.
function transactionScope(tx) {
  const scope = Object.create(tx);
  scope.transaction = async (callback) => callback(scope);
  return scope;
}

module.exports = { transactionScope };
