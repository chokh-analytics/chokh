// The public keys this build accepts a licence from, baked in at compile time.
//
// Baked in and never read from the environment. A public key that an operator
// can set is the whole gate handed to the person it exists to stop: they mint
// their own pair, put their own public key in the environment, and every paid
// feature is theirs. So it lives here, in the source, and changing it means
// building a new image.
//
// It is a list and not a constant, because that is how the signing pair is
// rotated without breaking a key somebody already has. Add the new public key
// in one release, mint with the new private key from then on, and drop the old
// entry a release later once every live key is on the new pair. A customer's
// own key is rotated differently and more often: a new key with a later expiry,
// signed by the same pair, swapped into one environment variable.
//
// EMPTY ON PURPOSE. The private half belongs to the founder and exists on their
// machine alone, so nothing in this repository, this image, this CI run or any
// report can generate it, print it or store it. An empty list means this build
// has no issuer and refuses every key, which is the right thing for a build
// that has none. The founder runs `chokh-license keygen`, keeps the private
// key, and adds the public line here in a commit of their own.
//
// Tests never touch this. They generate a throwaway pair in memory and pass
// their own public key to verifyLicense, which takes the list as a parameter
// for exactly that reason.
export const PUBLIC_KEYS: readonly string[] = [];
