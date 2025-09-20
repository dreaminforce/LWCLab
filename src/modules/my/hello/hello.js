import { LightningElement, api } from 'lwc';
export default class Hello extends LightningElement {
  @api name = 'World';
}