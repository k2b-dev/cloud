/** workerd's npm entry exports the absolute path to its platform-native binary. */
declare module "workerd" {
  const executable: string;
  export default executable;
}
