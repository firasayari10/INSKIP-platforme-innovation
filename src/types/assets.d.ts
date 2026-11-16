/** Fichiers image importés depuis le code : Bun les copie dans dist/ et renvoie leur URL. */
declare module "*.png" {
  const url: string;
  export default url;
}
