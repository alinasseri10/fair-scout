(function(root) {
  'use strict';
  const supplierKeys = ['company','companyChinese','brand','booth','contact','jobTitle','phone','whatsapp','wechatId','email','website','address','category'];
  const productKeys = ['productType','material','gsm','sizes','moq','unitPrice','currency','priceUnit','quotation'];
  const categories = ['T-shirts','Hoodies','Crewnecks','Polos','Jackets','Workwear','Hats','Other'];
  function object(value, keys, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key=>!keys.includes(key))) throw Error('Invalid '+label+' structure');
  }
  function text(value, nullable=true) {
    if (nullable && value===null) return null;
    if (typeof value!=='string' || value.length>4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw Error('Invalid extracted text');
    return value.trim();
  }
  function validateResult(value) {
    object(value,['supplier','products','evidence','warnings'],'recognition result');
    object(value.supplier,supplierKeys,'supplier');
    const supplier={};
    for(const key of supplierKeys) {
      if (!(key in value.supplier)) throw Error('Missing supplier field: '+key);
      supplier[key]=text(value.supplier[key]);
    }
    if(supplier.category && !categories.includes(supplier.category)) throw Error('Invalid garment category');
    if(supplier.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supplier.email)) throw Error('Invalid extracted email');
    if(!Array.isArray(value.products) || value.products.length>40) throw Error('Invalid product list');
    const products=value.products.map(product=>{
      object(product,productKeys,'product');
      const result={};for(const key of productKeys) {if(!(key in product)) throw Error('Missing product field: '+key);result[key]=text(product[key]);}
      if(result.currency && !/^[A-Z]{3}$/.test(result.currency)) throw Error('Currency must be a printed, unambiguous ISO code');
      return result;
    });
    if(!Array.isArray(value.evidence) || value.evidence.length>200 || !Array.isArray(value.warnings) || value.warnings.length>40) throw Error('Invalid evidence or warnings');
    const evidence=value.evidence.map(item=>{
      object(item,['field','text','uncertain'],'evidence');
      const field=text(item.field,false);
      if(!supplierKeys.includes(field) && !/^products\.\d+\.(productType|material|gsm|sizes|moq|unitPrice|currency|priceUnit|quotation)$/.test(field)) throw Error('Invalid evidence field');
      if(typeof item.uncertain!=='boolean') throw Error('Invalid uncertainty flag');
      return {field,text:text(item.text,false),uncertain:item.uncertain};
    });
    // Every nonempty extracted field needs source evidence; visual categories must
    // explicitly say they are visual suggestions in their evidence text.
    for(const [key,entry] of Object.entries(supplier)) if(entry && !evidence.some(e=>e.field===key && e.text)) throw Error('Missing evidence: '+key);
    products.forEach((product,index)=>{for(const [key,entry] of Object.entries(product)) if(entry && !evidence.some(e=>e.field===`products.${index}.${key}` && e.text)) throw Error('Missing product evidence');});
    return {supplier,products,evidence,warnings:value.warnings.map(item=>text(item,false))};
  }
  function emptyResult() {return {supplier:Object.fromEntries(supplierKeys.map(key=>[key,null])),products:[],evidence:[],warnings:[]};}
  const api={supplierKeys,productKeys,categories,validateResult,emptyResult};
  if(typeof module!=='undefined' && module.exports) module.exports=api; else root.FairScoutSchema=api;
})(globalThis);
