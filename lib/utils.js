/**
 * Checks a given input string.
 * @private
 * @param {String | undefined} input input string
 * @returns {input is string}
 * `true` if is string and length != 0, `false` otherwise.
 */
function isValidString(input) {
  return typeof input === 'string' && input.length > 0;
}

module.exports = {isValidString};
