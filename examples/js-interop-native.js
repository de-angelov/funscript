export const findNickname = (id) =>
  Promise.resolve(id === "known" ? "Ada" : null);

export const loadProfile = () => Promise.resolve({ name: "Ada" });
